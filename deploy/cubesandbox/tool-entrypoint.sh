#!/bin/bash
set -eu

ulimit -n 1024
ulimit -u 128

exec setpriv \
  --no-new-privs \
  /usr/bin/node \
  /app/packages/tool-sandbox/src/cube-tool-service.ts
