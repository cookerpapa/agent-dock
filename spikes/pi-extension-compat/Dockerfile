FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

LABEL org.opencontainers.image.title="AgentDock Pi RPC compatibility spike" \
      org.opencontainers.image.description="Zero-token Phase 0 sandbox contract probe"

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY spikes/pi-extension-compat/package.json spikes/pi-extension-compat/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY spikes/pi-extension-compat/extension spikes/pi-extension-compat/extension
COPY spikes/pi-extension-compat/src spikes/pi-extension-compat/src

ENV NODE_ENV=production \
    AGENT_DOCK_REQUIRE_NON_ROOT=1 \
    PI_COMMAND=/app/node_modules/.bin/pi \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1

STOPSIGNAL SIGTERM
USER 1000:1000

CMD ["node", "spikes/pi-extension-compat/src/run-spike.ts"]
