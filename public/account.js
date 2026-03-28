(function () {
    const STATE_KEYS = [
        'gc_cfg',
        'gc_theme',
        'gc_plugins',
        'gc_convs',
        'gc_user_memory',
        'gc_pending_approvals',
        'gc_skill_packs',
        'gc_tts_voice',
        'gc_tts_autoplay',
        'gc_sb_collapsed'
    ];

    const JSON_STATE_KEYS = new Set([
        'gc_cfg',
        'gc_plugins',
        'gc_convs',
        'gc_user_memory',
        'gc_pending_approvals',
        'gc_skill_packs'
    ]);

    let currentUser = null;
    let lastSnapshot = '';
    let syncTimer = null;
    let syncLoopStarted = false;
    let shellMounted = false;
    let syncFailures = 0;
    let syncBackoffMs = 2000;
    const SYNC_MAX_BACKOFF = 60000;
    const SYNC_MAX_FAILURES = 10;
    let syncPaused = false;

    function clearTrackedState() {
        for (const key of STATE_KEYS) localStorage.removeItem(key);
    }

    function stateValueFromStorage(key) {
        const raw = localStorage.getItem(key);
        if (raw === null) return undefined;
        if (!JSON_STATE_KEYS.has(key)) return raw;
        try { return JSON.parse(raw); } catch (_) { return raw; }
    }

    function writeStateValue(key, value) {
        if (value === undefined) {
            localStorage.removeItem(key);
            return;
        }
        if (JSON_STATE_KEYS.has(key)) {
            localStorage.setItem(key, JSON.stringify(value));
            return;
        }
        localStorage.setItem(key, String(value));
    }

    function collectState() {
        const state = {};
        for (const key of STATE_KEYS) {
            const value = stateValueFromStorage(key);
            if (value !== undefined) state[key] = value;
        }
        return state;
    }

    function stableStateString(state) {
        const ordered = {};
        for (const key of STATE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(state, key)) ordered[key] = state[key];
        }
        return JSON.stringify(ordered);
    }

    function hydrateState(state) {
        clearTrackedState();
        const safeState = state && typeof state === 'object' ? state : {};
        for (const key of STATE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(safeState, key)) writeStateValue(key, safeState[key]);
        }
        lastSnapshot = stableStateString(collectState());
    }

    async function parseJsonResponse(res) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return res.json().catch(() => ({}));
        const text = await res.text().catch(() => '');
        return text ? { error: text } : {};
    }

    async function fetchJson(url, options) {
        const res = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...options
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) {
            const error = new Error(data.error || ('HTTP ' + res.status));
            error.status = res.status;
            throw error;
        }
        return data;
    }

    async function bootstrap() {
        try {
            const me = await fetchJson('/auth/me');
            currentUser = me.user || null;
            const statePayload = await fetchJson('/api/state');
            hydrateState(statePayload.state || {});
            return { authenticated: true, user: currentUser };
        } catch (error) {
            currentUser = null;
            clearTrackedState();
            if (location.pathname !== '/login' && location.pathname !== '/login.html') {
                location.replace('/login');
                return { authenticated: false, redirected: true };
            }
            return { authenticated: false, error };
        }
    }

    function updateSyncBadge(text, state) {
        const badge = document.getElementById('account-sync-status');
        if (!badge) return;
        badge.textContent = text;
        badge.dataset.state = state;
    }

    async function syncState(options = {}) {
        if (!currentUser) return;
        const state = collectState();
        const serialized = stableStateString(state);
        if (!options.force && serialized === lastSnapshot) return;

        const payload = JSON.stringify({ state });
        if (options.beacon && navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            const ok = navigator.sendBeacon('/api/state', blob);
            if (ok) {
                lastSnapshot = serialized;
                updateSyncBadge('Salvo', 'ok');
            }
            return;
        }

        updateSyncBadge('Salvando...', 'busy');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const res = await fetch('/api/state', {
                method: 'POST',
                credentials: 'same-origin',
                keepalive: Boolean(options.keepalive),
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (res.status === 401) {
                location.replace('/login');
                return;
            }

            if (!res.ok) {
                const data = await parseJsonResponse(res);
                updateSyncBadge('Falha ao salvar', 'error');
                throw new Error(data.error || ('HTTP ' + res.status));
            }

            lastSnapshot = serialized;
            syncFailures = 0;
            syncBackoffMs = 2000;
            syncPaused = false;
            updateSyncBadge('Salvo', 'ok');
        } catch (err) {
            clearTimeout(timeout);
            syncFailures++;
            syncBackoffMs = Math.min(syncBackoffMs * 2, SYNC_MAX_BACKOFF);
            if (syncFailures >= SYNC_MAX_FAILURES) {
                syncPaused = true;
                updateSyncBadge('Sync pausado', 'error');
                console.warn('[Sync] Pausado após ' + syncFailures + ' falhas consecutivas.');
            } else {
                updateSyncBadge('Falha (' + syncFailures + ')', 'error');
            }
            throw err;
        }
    }

    function scheduleSync(delay = 700) {
        if (!currentUser || syncPaused) return;
        clearTimeout(syncTimer);
        const effectiveDelay = syncFailures > 0 ? Math.max(delay, syncBackoffMs) : delay;
        syncTimer = setTimeout(() => {
            syncState().catch((error) => {
                console.warn('Falha ao sincronizar estado:', error.message);
            });
        }, effectiveDelay);
    }

    function startSync() {
        if (syncLoopStarted) return;
        syncLoopStarted = true;

        const schedule = () => scheduleSync();
        ['input', 'change', 'click'].forEach((eventName) => {
            document.addEventListener(eventName, schedule, true);
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) syncState({ beacon: true }).catch(() => { });
        });

        window.addEventListener('beforeunload', () => {
            syncState({ beacon: true }).catch(() => { });
        });

        setInterval(() => {
            if (syncPaused) return;
            const snapshot = stableStateString(collectState());
            if (snapshot !== lastSnapshot) scheduleSync(syncFailures > 0 ? syncBackoffMs : 1500);
        }, 3000);
    }

    function injectShellStyles() {
        if (document.getElementById('account-shell-style')) return;
        const style = document.createElement('style');
        style.id = 'account-shell-style';
        style.textContent = `
            #account-shell { margin-left: auto; display: inline-flex; align-items: center; gap: 10px; padding-left: 12px; }
            #account-pill, #account-logout { border-radius: 999px; border: 1px solid var(--border); background: rgba(255,255,255,0.04); color: var(--text); height: 36px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; font: inherit; }
            #account-pill { max-width: 260px; }
            #account-pill strong { font-size: 13px; font-weight: 600; font-family: var(--font-display); }
            #account-sync-status { font-size: 11px; color: var(--muted); padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); }
            #account-sync-status[data-state="busy"] { color: var(--accent2); }
            #account-sync-status[data-state="error"] { color: var(--danger); }
            #account-logout { cursor: pointer; transition: border-color .18s ease, color .18s ease; }
            #account-logout:hover { border-color: var(--accent); color: var(--accent); }
            @media (max-width: 900px) { #account-shell { width: 100%; justify-content: flex-end; flex-wrap: wrap; } }
            @media (max-width: 640px) { #account-pill { width: 100%; max-width: none; justify-content: space-between; } #account-logout { width: 100%; justify-content: center; } }
        `;
        document.head.appendChild(style);
    }

    async function logout() {
        try {
            await fetch('/auth/logout', {
                method: 'POST',
                credentials: 'same-origin'
            });
        } catch (_) { }
        clearTrackedState();
        location.replace('/login');
    }

    function mountShell() {
        if (shellMounted || !currentUser) return;
        const target = document.getElementById('cfg-account-slot') || document.getElementById('topbar');
        if (!target) return;

        injectShellStyles();

        const shell = document.createElement('div');
        shell.id = 'account-shell';
        shell.innerHTML = `
            <div id="account-pill">
                <strong>${currentUser.login}</strong>
                <span id="account-sync-status" data-state="ok">Salvo</span>
            </div>
            <button id="account-logout" type="button">Sair</button>
        `;

        target.appendChild(shell);
        shell.querySelector('#account-logout')?.addEventListener('click', logout);
        shellMounted = true;
    }

    window.__ACCOUNT_BOOTSTRAP__ = bootstrap();
    window.__skillflowAccount = {
        mountShell,
        startSync,
        syncState,
        getUser() {
            return currentUser;
        }
    };
})();
