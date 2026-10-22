# $PIXEL — one container serves the web app, the REST API and the WebSocket.
# State lives in DATA_DIR (/data): mount a volume there (docker -v, or a Railway volume).
# No VOLUME instruction: Railway rejects Dockerfiles that declare one.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# tsx and the web build tools are devDependencies; keep them even if NODE_ENV=production.
RUN npm ci --include=dev

COPY . .
RUN npm run build

ENV DATA_DIR=/data \
    PORT=8787 \
    HOST=0.0.0.0
EXPOSE 8787
CMD ["npm", "start"]
