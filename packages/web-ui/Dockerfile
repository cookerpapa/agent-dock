FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder

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

FROM golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc AS caddy-builder

ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org|direct
RUN apk add --no-cache ca-certificates git
RUN git clone --filter=blob:none https://github.com/caddyserver/caddy.git /src/caddy \
    && cd /src/caddy \
    && git checkout --detach e2eee6a7fce366321294c9c2a79f3146891dcbdf \
    && test "$(git rev-parse HEAD)" = "e2eee6a7fce366321294c9c2a79f3146891dcbdf"
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    cd /src/caddy \
    && downloaded=0 \
    && for attempt in 1 2 3; do \
      if go get google.golang.org/grpc@v1.82.1 && go mod download; then downloaded=1; break; fi; \
    done \
    && test "$downloaded" = 1 \
    && go build -trimpath \
      -ldflags="-s -w -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4-agent-dock" \
      -o /go/bin/caddy ./cmd/caddy \
    && /go/bin/caddy version | grep -F "v2.11.4-agent-dock"

FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=unknown
LABEL org.opencontainers.image.title="AgentDock production web ingress" \
      org.opencontainers.image.description="Static authenticated Web UI and narrow /v1 reverse proxy" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"

ENV HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data

COPY --from=caddy-builder /go/bin/caddy /usr/bin/caddy
COPY packages/web-ui/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/packages/web-ui/dist /srv

USER 1000:1000
WORKDIR /srv
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
