FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=development
LABEL org.opencontainers.image.title="AgentDock provider egress relay" \
      org.opencontainers.image.description="Host-proxy bridge for the trusted model gateway" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY packages/provider-egress-relay/package.json packages/provider-egress-relay/package.json
COPY packages/provider-egress-relay/src packages/provider-egress-relay/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/packages/provider-egress-relay/src/main.ts"]
