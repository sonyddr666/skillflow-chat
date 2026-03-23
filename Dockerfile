FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY skills ./skills
COPY workspace ./workspace

EXPOSE 9321

CMD ["npm", "start"]
