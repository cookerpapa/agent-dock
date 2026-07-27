FROM kopia/kopia@sha256:89fd95ee2942880ca00eae964266958a394421ddbdf69bca62e38afc55f5900e AS kopia

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-manager/package.json packages/sandbox-manager/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=unknown
LABEL org.opencontainers.image.title="AgentDock Sandbox Manager" \
      org.opencontainers.image.description="Narrow lifecycle service for credential-free isolated tool sandboxes" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=kopia /bin/kopia /usr/local/bin/kopia
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages/sandbox-manager/node_modules /app/packages/sandbox-manager/node_modules
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
RUN cd /app/packages/sandbox-manager \
    && node --input-type=module --eval "await import('undici')" \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/sandbox-manager/tsconfig.json"]
CMD ["/app/packages/sandbox-manager/src/main.ts"]
