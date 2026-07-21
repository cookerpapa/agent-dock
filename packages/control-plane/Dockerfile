FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/harden-pi-dependencies.mjs scripts/harden-pi-dependencies.mjs
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/fake-model-server/package.json packages/fake-model-server/package.json
COPY packages/github-gateway/package.json packages/github-gateway/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts \
    && node scripts/harden-pi-dependencies.mjs \
    && node scripts/harden-pi-dependencies.mjs --check \
    && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=unknown
LABEL org.opencontainers.image.title="AgentDock production control plane" \
      org.opencontainers.image.description="Authenticated REST/SSE and remote Supervisor control plane" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/control-plane/src packages/control-plane/src
COPY packages/database/package.json packages/database/package.json
COPY packages/database/src packages/database/src
COPY packages/domain/package.json packages/domain/package.json
COPY packages/domain/src packages/domain/src
COPY packages/fake-model-server/package.json packages/fake-model-server/package.json
COPY packages/fake-model-server/src packages/fake-model-server/src
COPY packages/github-gateway/package.json packages/github-gateway/package.json
COPY packages/github-gateway/src packages/github-gateway/src
COPY packages/observability/package.json packages/observability/package.json
COPY packages/observability/src packages/observability/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/control-plane/tsconfig.json"]
CMD ["/app/packages/control-plane/src/main.ts"]
