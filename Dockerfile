# $PIXEL — one container serves the web app, the REST API and the WebSocket.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

ENV DATA_DIR=/data \
    PORT=8787 \
    HOST=0.0.0.0
VOLUME /data
EXPOSE 8787
CMD ["npm", "start"]
