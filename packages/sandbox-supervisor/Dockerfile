FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

LABEL org.opencontainers.image.title="AgentDock isolated Pi workspace worker" \
      org.opencontainers.image.description="Isolated Pi workspace worker with optional broker-only model access"

RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get -o Acquire::Retries=5 update \
    && (apt-get install --fix-missing --yes --no-install-recommends git openjdk-17-jdk-headless \
        || apt-get install --fix-missing --yes --no-install-recommends git openjdk-17-jdk-headless \
        || apt-get install --fix-missing --yes --no-install-recommends git openjdk-17-jdk-headless)

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/fake-model-server/package.json packages/fake-model-server/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY packages/fake-model-server/src packages/fake-model-server/src
COPY packages/observability/src packages/observability/src
COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/workspace-runtime/src packages/workspace-runtime/src
COPY --chown=1000:1000 packages/sandbox-supervisor/test/fixtures/sample-java-repair /opt/agent-dock/sample-java-repair

ENV NODE_ENV=production \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

STOPSIGNAL SIGTERM
USER 1000:1000
WORKDIR /workspace

ENTRYPOINT ["node", "/app/packages/sandbox-supervisor/src/docker-sandbox-worker.ts"]
