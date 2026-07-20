FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/github-gateway/package.json packages/github-gateway/package.json
COPY packages/github-gateway/tsconfig.json packages/github-gateway/tsconfig.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

LABEL org.opencontainers.image.title="AgentDock trusted GitHub Gateway" \
      org.opencontainers.image.description="GitHub App token broker, exact snapshot importer and pull-request delivery boundary"

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

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/github-gateway/tsconfig.json"]
CMD ["/app/packages/github-gateway/src/main.ts"]
