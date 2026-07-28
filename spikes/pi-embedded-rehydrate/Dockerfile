FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

LABEL org.opencontainers.image.title="AgentDock embedded rehydrate spike" \
      org.opencontainers.image.description="Zero-token Phase 0 execution-density probe"

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/harden-pi-dependencies.mjs scripts/harden-pi-dependencies.mjs
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY spikes/pi-embedded-rehydrate/package.json spikes/pi-embedded-rehydrate/package.json
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts \
    && node scripts/harden-pi-dependencies.mjs \
    && node scripts/harden-pi-dependencies.mjs --check \
    && npm cache clean --force

COPY spikes/pi-embedded-rehydrate/src spikes/pi-embedded-rehydrate/src

ENV NODE_ENV=production \
    AGENT_DOCK_REQUIRE_NON_ROOT=1 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1

STOPSIGNAL SIGTERM
USER 1000:1000

CMD ["node", "spikes/pi-embedded-rehydrate/src/run-spike.ts"]
