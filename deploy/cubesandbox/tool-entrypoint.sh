#!/bin/bash
set -eu

ulimit -n 1024
ulimit -u 128

exec setpriv \
  --no-new-privs \
  --reuid=1000 \
  --regid=1000 \
  --clear-groups \
  /usr/bin/node \
  /app/packages/tool-sandbox/src/cube-tool-service.ts
