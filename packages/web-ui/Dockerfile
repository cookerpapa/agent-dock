FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/web-ui/package.json packages/web-ui/package.json
RUN sh scripts/retry-npm-command.sh ci --ignore-scripts
COPY packages/protocol/src packages/protocol/src
COPY packages/web-ui/index.html packages/web-ui/index.html
COPY packages/web-ui/src packages/web-ui/src
COPY packages/web-ui/tsconfig.json packages/web-ui/tsconfig.json
COPY packages/web-ui/vite.config.ts packages/web-ui/vite.config.ts
ENV VITE_PI_CLOUD_AUTH_REQUIRED=true
RUN npm run build --workspace @pi-cloud/web-ui

FROM golang:1.26.6-alpine3.23@sha256:5978cc992ad5ef96a7469713c8af849c1433824761ce3be2c56381403cd8d9a3 AS caddy-builder

ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org|direct
RUN installed=0 \
    && for attempt in 1 2 3; do \
      if apk add --no-cache ca-certificates git; then installed=1; break; fi; \
      sleep "$((attempt * 2))"; \
    done \
    && test "$installed" = 1
RUN cloned=0 \
    && for attempt in 1 2 3; do \
      rm -rf /src/caddy \
      && if git clone --filter=blob:none https://github.com/caddyserver/caddy.git /src/caddy; then \
        cloned=1; break; \
      fi; \
      sleep "$((attempt * 2))"; \
    done \
    && test "$cloned" = 1 \
    && cd /src/caddy \
    && git checkout --detach e2eee6a7fce366321294c9c2a79f3146891dcbdf \
    && test "$(git rev-parse HEAD)" = "e2eee6a7fce366321294c9c2a79f3146891dcbdf"
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    cd /src/caddy \
    && export GOPROXY='https://goproxy.cn|https://proxy.golang.org|direct' \
    && downloaded=0 \
    && for attempt in 1 2 3; do \
      if go get google.golang.org/grpc@v1.82.1 golang.org/x/text@v0.39.0 \
        && go mod download; then downloaded=1; break; fi; \
    done \
    && test "$downloaded" = 1 \
    && go build -trimpath \
      -ldflags="-s -w -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4-pi-cloud" \
      -o /go/bin/caddy ./cmd/caddy \
    && /go/bin/caddy version | grep -F "v2.11.4-pi-cloud"

FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud production web ingress" \
      org.opencontainers.image.description="Static authenticated Web UI and narrow /v1 reverse proxy" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"

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
