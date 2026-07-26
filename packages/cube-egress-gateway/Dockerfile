FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=unknown
LABEL org.opencontainers.image.title="AgentDock Cube egress gateway" \
      org.opencontainers.image.description="Hot-configured public HTTP(S) proxy boundary for CubeSandbox microVMs" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV NODE_ENV=production
WORKDIR /app
COPY packages/dependency-egress-proxy/src/address-policy.ts packages/dependency-egress-proxy/src/address-policy.ts
COPY packages/cube-egress-gateway/src packages/cube-egress-gateway/src
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/packages/cube-egress-gateway/src/main.ts"]
