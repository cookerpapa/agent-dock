FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=development
LABEL org.opencontainers.image.title="AgentDock untrusted tool sandbox" \
      org.opencontainers.image.description="Credential-free offline workspace and tool worker" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

RUN install -d -m 0755 /opt/agent-dock \
    && printf '%s\n' "${AGENT_DOCK_REVISION}" > /opt/agent-dock/image-revision \
    && chmod 0444 /opt/agent-dock/image-revision

RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get -o Acquire::Retries=5 update \
    && (apt-get install --fix-missing --yes --no-install-recommends bash git openjdk-17-jdk-headless python3 python3-pip python3-venv \
        || apt-get install --fix-missing --yes --no-install-recommends bash git openjdk-17-jdk-headless python3 python3-pip python3-venv) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/tool-sandbox/package.json packages/tool-sandbox/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm install --global npm@12.0.1 \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY packages/protocol/src packages/protocol/src
COPY packages/tool-sandbox/src packages/tool-sandbox/src
COPY packages/workspace-runtime/src packages/workspace-runtime/src
COPY --chown=1000:1000 packages/sandbox-supervisor/test/fixtures/sample-java-repair /opt/agent-dock/sample-java-repair

ENV NODE_ENV=production
STOPSIGNAL SIGTERM
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/tool-sandbox/src/tool-worker.ts"]
