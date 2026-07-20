FROM docker@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS docker-cli

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-manager/package.json packages/sandbox-manager/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99
LABEL org.opencontainers.image.title="AgentDock Sandbox Manager" \
      org.opencontainers.image.description="Narrow Docker-owning lifecycle service for credential-free tool sandboxes"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/observability/package.json packages/observability/package.json
COPY packages/observability/src packages/observability/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-manager/package.json packages/sandbox-manager/package.json
COPY packages/sandbox-manager/tsconfig.json packages/sandbox-manager/tsconfig.json
COPY packages/sandbox-manager/src packages/sandbox-manager/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
STOPSIGNAL SIGTERM
USER 0:0
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/sandbox-manager/tsconfig.json"]
CMD ["/app/packages/sandbox-manager/src/main.ts"]
