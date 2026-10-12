FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
COPY src ./src
COPY simulator-assets ./simulator-assets

ENV DATA_DIR=/data \
    BRIDGE_PORT=3080
VOLUME ["/data"]
EXPOSE 3080

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${BRIDGE_PORT}/api/health" || exit 1
USER node
CMD ["node", "server.mjs"]
