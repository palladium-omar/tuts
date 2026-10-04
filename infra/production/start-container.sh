#!/bin/sh
set -eu
case "$SERVICE" in
  web)
    cd /app/apps/web
    exec node .next/standalone/apps/web/server.js
    ;;
  gateway) exec node /app/apps/gateway/dist/main.js ;;
  platform|clients|scheduling|learning|billing|payments|notifications|integrations)
    cd "/app/services/$SERVICE"
    exec node dist/main.js
    ;;
  *) echo 'Unknown service' >&2; exit 1 ;;
esac
