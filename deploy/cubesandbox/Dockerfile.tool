ARG CUBE_BASE_IMAGE=ghcr.io/tencentcloud/cubesandbox-base:2026.16@sha256:34ea312a63a5534e66ab17005c23d7fbaf33c38bccd5411ee402d901e63a3193
ARG PYTHON_BASE_IMAGE=python:3.11.13-slim-bullseye@sha256:9e25f400253a5fa3191813d6a67eb801ca1e6f012b3bd2588fa6920b59e3eba6
ARG NODE_BASE_IMAGE=node:24.18.0-bullseye-slim@sha256:aca89821b1f09df223227ff2abe075fc3161f05604d3b61309f46820a5938020
FROM ${PYTHON_BASE_IMAGE} AS python-runtime
FROM ${NODE_BASE_IMAGE} AS node-runtime

FROM ${CUBE_BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        ca-certificates \
        git \
        openjdk-17-jdk-headless \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-runtime /usr/local /usr/local
COPY --from=node-runtime /usr/local /usr/local
RUN ln -sf /usr/local/bin/python3 /usr/bin/python3 \
    && ln -sf /usr/local/bin/node /usr/bin/node

RUN if ! getent group 1000 >/dev/null; then groupadd --gid 1000 agent-dock; fi \
    && if ! getent passwd 1000 >/dev/null; then \
         useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash agent-dock; \
       fi \
    && install -d -o 1000 -g 1000 -m 0700 \
         /workspace \
         /tmp/agent-dock-tool-home \
         /opt/agent-dock

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/tool-sandbox/package.json packages/tool-sandbox/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
RUN npm install --global npm@12.0.1 \
    && npm pack --pack-destination /tmp brace-expansion@5.0.8 \
    && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && install -d /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && tar -xzf /tmp/brace-expansion-5.0.8.tgz \
        --strip-components=1 \
        -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && rm /tmp/brace-expansion-5.0.8.tgz \
    && node -e 'if (require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version !== "5.0.8") process.exit(1)' \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY packages/protocol/src packages/protocol/src
COPY packages/tool-sandbox/src packages/tool-sandbox/src
COPY packages/workspace-runtime/src packages/workspace-runtime/src
COPY --chown=1000:1000 \
  packages/sandbox-supervisor/test/fixtures/sample-java-repair \
  /opt/agent-dock/sample-java-repair
COPY deploy/cubesandbox/tool-entrypoint.sh /usr/local/bin/agent-dock-cube-tool
RUN chmod 0555 /usr/local/bin/agent-dock-cube-tool

ARG AGENT_DOCK_VERSION=development
ARG AGENT_DOCK_REVISION=development
LABEL org.opencontainers.image.title="AgentDock CubeSandbox tool template" \
      org.opencontainers.image.description="Credential-free AgentDock Tool Worker for CubeSandbox KVM microVMs" \
      org.opencontainers.image.version="${AGENT_DOCK_VERSION}" \
      org.opencontainers.image.revision="${AGENT_DOCK_REVISION}"
RUN printf '%s\n' "${AGENT_DOCK_REVISION}" > /opt/agent-dock/image-revision \
    && chmod 0444 /opt/agent-dock/image-revision

ENV NODE_ENV=production \
    HOME=/tmp/agent-dock-tool-home

WORKDIR /workspace
# The base image's OCI metadata also declares 49983 and Docker has no
# "UNEXPOSE" instruction. The Cube template registers only 49984, and the
# compatibility gate proves that no process listens on 49983.
EXPOSE 49984

# Deliberately replace cubesandbox-base's entrypoint: the inherited script
# starts envd, which would be a second unmediated command/file channel inside
# the guest. The one root-owned AgentDock supervisor authenticates every
# mutable request, starts Tool Workers and user commands as uid 1000, and
# enforces the checkpoint/rebind boundary while the Session Cube stays running.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/agent-dock-cube-tool"]
