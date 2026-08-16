FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts/retry-npm-command.sh scripts/retry-npm-command.sh
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/tool-broker/package.json packages/tool-broker/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN sh scripts/retry-npm-command.sh ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG PI_CLOUD_VERSION=development
ARG PI_CLOUD_REVISION=unknown
LABEL org.opencontainers.image.title="PiCloud Tool Broker" \
      org.opencontainers.image.description="Narrow lifecycle service for credential-free isolated tool sandboxes" \
      org.opencontainers.image.version="${PI_CLOUD_VERSION}" \
      org.opencontainers.image.revision="${PI_CLOUD_REVISION}"
ENV NODE_ENV=production
RUN set -eu; \
    installed=0; \
    attempt=1; \
    while [ "$attempt" -le 3 ]; do \
      rm -rf /var/lib/apt/lists/*; \
      if apt-get \
          -o Acquire::Retries=3 \
          -o Acquire::http::Timeout=30 \
          update \
        && apt-get \
          -o Acquire::Retries=3 \
          -o Acquire::http::Timeout=30 \
          install --yes --no-install-recommends git; then \
        installed=1; \
        break; \
      fi; \
      dpkg --configure -a || true; \
      sleep "$((attempt * 2))"; \
      attempt="$((attempt + 1))"; \
    done; \
    test "$installed" = 1; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages/tool-broker/node_modules /app/packages/tool-broker/node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/database/package.json packages/database/package.json
COPY packages/database/src packages/database/src
COPY packages/domain/package.json packages/domain/package.json
COPY packages/domain/src packages/domain/src
COPY packages/observability/package.json packages/observability/package.json
COPY packages/observability/src packages/observability/src
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol/src packages/protocol/src
COPY packages/tool-broker/package.json packages/tool-broker/package.json
COPY packages/tool-broker/tsconfig.json packages/tool-broker/tsconfig.json
COPY packages/tool-broker/src packages/tool-broker/src
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/workspace-runtime/src packages/workspace-runtime/src
RUN cd /app/packages/tool-broker \
    && node --input-type=module --eval "await import('@pi-cloud/database'); await import('undici')" \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
STOPSIGNAL SIGTERM
USER 1000:1000
ENTRYPOINT ["node", "/app/node_modules/tsx/dist/cli.mjs", "--tsconfig", "/app/packages/tool-broker/tsconfig.json"]
CMD ["/app/packages/tool-broker/src/main.ts"]
