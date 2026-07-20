FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/fake-model-server/package.json packages/fake-model-server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-manager/package.json packages/sandbox-manager/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

LABEL org.opencontainers.image.title="AgentDock trusted Supervisor host" \
      org.opencontainers.image.description="Credentialed Pi Agent Runner without Docker or user tool execution"

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
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-manager/package.json packages/sandbox-manager/package.json
COPY packages/sandbox-manager/src packages/sandbox-manager/src
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/supervisor-host/src packages/supervisor-host/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/supervisor-host/tsconfig.json"]
CMD ["/app/packages/supervisor-host/src/main.ts"]
