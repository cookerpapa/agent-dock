FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

LABEL org.opencontainers.image.title="AgentDock Pi RPC compatibility spike" \
      org.opencontainers.image.description="Zero-token Phase 0 sandbox contract probe"

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/harden-pi-dependencies.mjs scripts/harden-pi-dependencies.mjs
COPY packages/fake-model-server/package.json packages/fake-model-server/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY spikes/pi-extension-compat/package.json spikes/pi-extension-compat/package.json
RUN npm ci --omit=dev --ignore-scripts \
    && node scripts/harden-pi-dependencies.mjs \
    && node scripts/harden-pi-dependencies.mjs --check \
    && npm cache clean --force

COPY packages/fake-model-server/src packages/fake-model-server/src
COPY packages/observability/src packages/observability/src
COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/workspace-runtime/src packages/workspace-runtime/src
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
