FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/github-gateway/package.json packages/github-gateway/package.json
COPY packages/github-gateway/tsconfig.json packages/github-gateway/tsconfig.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=unknown
LABEL org.opencontainers.image.title="AgentDock trusted GitHub Gateway" \
      org.opencontainers.image.description="GitHub App token broker, exact snapshot importer and pull-request delivery boundary" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/github-gateway/package.json packages/github-gateway/package.json
COPY packages/github-gateway/tsconfig.json packages/github-gateway/tsconfig.json
COPY packages/github-gateway/src packages/github-gateway/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/github-gateway/tsconfig.json"]
CMD ["/app/packages/github-gateway/src/main.ts"]
