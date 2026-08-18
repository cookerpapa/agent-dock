FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/harden-pi-dependencies.mjs scripts/harden-pi-dependencies.mjs
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/fake-model-server/package.json packages/fake-model-server/package.json
COPY packages/github-gateway/package.json packages/github-gateway/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/pi-session-postgres/package.json packages/pi-session-postgres/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/tool-broker/package.json packages/tool-broker/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts \
    && node scripts/harden-pi-dependencies.mjs \
    && node scripts/harden-pi-dependencies.mjs --check \
    && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud trusted Supervisor host" \
      org.opencontainers.image.description="Credentialed Pi Agent Runner without Docker or user tool execution" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages/tool-broker/node_modules /app/packages/tool-broker/node_modules
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
COPY packages/pi-session-postgres/package.json packages/pi-session-postgres/package.json
COPY packages/pi-session-postgres/src packages/pi-session-postgres/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/runtime-core/src packages/runtime-core/src
COPY packages/tool-broker/package.json packages/tool-broker/package.json
COPY packages/tool-broker/src packages/tool-broker/src
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/supervisor-host/src packages/supervisor-host/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN cd /app/packages/sandbox-supervisor \
    && chmod 0555 /app/packages/sandbox-supervisor/src/pi-subagents-cloud-shim.cjs \
    && node --import tsx --input-type=module --eval "await import('pi-subagents'); await import('@earendil-works/pi-coding-agent')" \
    && cd /app/packages/tool-broker \
    && node --input-type=module --eval "await import('undici')" \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/supervisor-host/tsconfig.json"]
CMD ["/app/packages/supervisor-host/src/main.ts"]
