FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=development
LABEL org.opencontainers.image.title="AgentDock dependency egress proxy" \
      org.opencontainers.image.description="Capability-scoped HTTPS CONNECT broker for untrusted environment setup" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY packages/dependency-egress-proxy/package.json packages/dependency-egress-proxy/package.json
COPY packages/dependency-egress-proxy/src packages/dependency-egress-proxy/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/packages/dependency-egress-proxy/src/main.ts"]
