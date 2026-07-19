FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/web-ui/package.json packages/web-ui/package.json
RUN npm ci --ignore-scripts
COPY packages/protocol/src packages/protocol/src
COPY packages/web-ui/index.html packages/web-ui/index.html
COPY packages/web-ui/src packages/web-ui/src
COPY packages/web-ui/tsconfig.json packages/web-ui/tsconfig.json
COPY packages/web-ui/vite.config.ts packages/web-ui/vite.config.ts
ENV VITE_AGENT_DOCK_AUTH_REQUIRED=true
RUN npm run build --workspace @agent-dock/web-ui

FROM caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

LABEL org.opencontainers.image.title="AgentDock production web ingress" \
      org.opencontainers.image.description="Static authenticated Web UI and narrow /v1 reverse proxy"

COPY packages/web-ui/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/packages/web-ui/dist /srv
RUN setcap -r /usr/bin/caddy

USER 1000:1000
EXPOSE 8080
