# Dependencies are pure JavaScript, so they are installed once on the build host's platform and
# copied into every target image. Running npm under QEMU for arm64 crashed with
# "Illegal instruction" on GitHub's runners.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.mjs ./
COPY src ./src
COPY simulator-assets ./simulator-assets
COPY third-party ./third-party

ENV DATA_DIR=/data \
    BRIDGE_PORT=3080
VOLUME ["/data"]
EXPOSE 3080

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${BRIDGE_PORT}/api/health" || exit 1
USER node
CMD ["node", "server.mjs"]
