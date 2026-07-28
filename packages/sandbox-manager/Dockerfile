FROM golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc AS kopia-builder
ENV GOPROXY=https://proxy.golang.org|direct
RUN installed=0 \
    && for attempt in 1 2 3; do \
      if apk add --no-cache ca-certificates git; then installed=1; break; fi; \
      sleep "$((attempt * 2))"; \
    done \
    && test "$installed" = 1
RUN cloned=0 \
    && for attempt in 1 2 3; do \
      rm -rf /src/kopia \
      && if git clone --filter=blob:none https://github.com/kopia/kopia.git /src/kopia; then \
        cloned=1; break; \
      fi; \
      sleep "$((attempt * 2))"; \
    done \
    && test "$cloned" = 1 \
    && cd /src/kopia \
    && git checkout --detach 72ec08fd8edb86c67ed27099bf1b955e1f308ffa \
    && test "$(git rev-parse HEAD)" = "72ec08fd8edb86c67ed27099bf1b955e1f308ffa"
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    cd /src/kopia \
    && go mod edit -toolchain=go1.26.5 \
    && downloaded=0 \
    && for attempt in 1 2 3; do \
      if go get google.golang.org/grpc@v1.82.1 && go mod download; then downloaded=1; break; fi; \
    done \
    && test "$downloaded" = 1 \
    && CGO_ENABLED=0 go build -trimpath \
      -ldflags="-s -w -X github.com/kopia/kopia/repo.BuildVersion=0.23.1-agent-dock -X github.com/kopia/kopia/repo.BuildInfo=72ec08fd8edb86c67ed27099bf1b955e1f308ffa -X github.com/kopia/kopia/repo.BuildGitHubRepo=kopia/kopia" \
      -o /out/kopia github.com/kopia/kopia \
    && /out/kopia --version | grep -F "0.23.1-agent-dock"

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
COPY --from=kopia-builder /out/kopia /usr/local/bin/kopia
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
