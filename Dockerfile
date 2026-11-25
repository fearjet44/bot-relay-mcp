# syntax=docker/dockerfile:1
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM docker.io/library/node:22-alpine
LABEL org.opencontainers.image.title="Bot Relay MCP" \
      org.opencontainers.image.description="Self-hosted MCP message relay and real-time push hub (SSE + LAN/Tailnet webhooks) for AI bots" \
      org.opencontainers.image.source="https://github.com/fearjet44/bot-relay-mcp" \
      org.opencontainers.image.licenses="Apache-2.0"

# The runtime only needs `node`; drop package managers to shrink the image and attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/relay.db

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts

USER node
EXPOSE 8080 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
