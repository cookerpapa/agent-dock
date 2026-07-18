FROM node:24.12.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY spikes/pi-extension-compat/package.json spikes/pi-extension-compat/package.json
RUN npm ci --omit=dev && npm cache clean --force

COPY packages/protocol/src packages/protocol/src
COPY packages/sandbox-supervisor/src packages/sandbox-supervisor/src
COPY spikes/pi-extension-compat/extension spikes/pi-extension-compat/extension
COPY spikes/pi-extension-compat/src spikes/pi-extension-compat/src

ENV PI_COMMAND=/app/node_modules/.bin/pi
USER node

CMD ["node", "spikes/pi-extension-compat/src/run-spike.ts"]
