FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/skills /app/workspace

EXPOSE 9321

CMD ["npm", "start"]
