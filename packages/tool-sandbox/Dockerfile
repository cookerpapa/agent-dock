FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

LABEL org.opencontainers.image.title="AgentDock untrusted tool sandbox" \
      org.opencontainers.image.description="Credential-free offline workspace and tool worker"

RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get -o Acquire::Retries=5 update \
    && (apt-get install --fix-missing --yes --no-install-recommends bash git openjdk-17-jdk-headless \
        || apt-get install --fix-missing --yes --no-install-recommends bash git openjdk-17-jdk-headless) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/tool-sandbox/package.json packages/tool-sandbox/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY packages/protocol/src packages/protocol/src
COPY packages/tool-sandbox/src packages/tool-sandbox/src
COPY packages/workspace-runtime/src packages/workspace-runtime/src
COPY --chown=1000:1000 packages/sandbox-supervisor/test/fixtures/sample-java-repair /opt/agent-dock/sample-java-repair

ENV NODE_ENV=production
STOPSIGNAL SIGTERM
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/tool-sandbox/src/tool-worker.ts"]
