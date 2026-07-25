FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=unknown
LABEL org.opencontainers.image.title="AgentDock Cube API authorizer" \
      org.opencontainers.image.description="Path-and-method-scoped auth callback for private CubeAPI management" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY packages/cube-api-authorizer/src packages/cube-api-authorizer/src
RUN install -d -o 1000 -g 1000 -m 0500 /run/agent-dock-secrets \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

STOPSIGNAL SIGTERM
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/packages/cube-api-authorizer/src/main.ts"]
