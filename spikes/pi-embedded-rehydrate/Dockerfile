FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

LABEL org.opencontainers.image.title="AgentDock embedded rehydrate spike" \
      org.opencontainers.image.description="Zero-token Phase 0 execution-density probe"

WORKDIR /app

COPY package.json package-lock.json ./
COPY spikes/pi-embedded-rehydrate/package.json spikes/pi-embedded-rehydrate/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY spikes/pi-embedded-rehydrate/src spikes/pi-embedded-rehydrate/src

ENV NODE_ENV=production \
    AGENT_DOCK_REQUIRE_NON_ROOT=1 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1

STOPSIGNAL SIGTERM
USER 1000:1000

CMD ["node", "spikes/pi-embedded-rehydrate/src/run-spike.ts"]
