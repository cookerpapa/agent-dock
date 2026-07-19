FROM docker@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS docker-cli

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

LABEL org.opencontainers.image.title="AgentDock trusted Supervisor host" \
      org.opencontainers.image.description="Exclusive Docker owner and remote AgentDock Supervisor"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
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
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY packages/supervisor-host/package.json packages/supervisor-host/package.json
COPY packages/supervisor-host/tsconfig.json packages/supervisor-host/tsconfig.json
COPY packages/supervisor-host/src packages/supervisor-host/src

# Docker socket access is deliberately root-equivalent. This trusted process is
# the only application container that receives the socket; spawned Pi workers do not.
STOPSIGNAL SIGTERM
USER 0:0
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/supervisor-host/tsconfig.json"]
CMD ["/app/packages/supervisor-host/src/main.ts"]
