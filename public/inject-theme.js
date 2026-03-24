// inject-theme.js — carrega mobile.css automaticamente
(function () {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './mobile.css';
  link.id = 'skillflow-theme';
  document.head.appendChild(link);
})();
