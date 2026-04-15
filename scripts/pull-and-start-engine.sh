#!/usr/bin/env bash
# Pull and start the sync-engine Docker image from Docker Hub on port 4020.
# Usage: ./scripts/pull-and-start-engine.sh [--pull-only | --no-pull | --pretty]

set -euo pipefail

case "${1:-}" in
  --pull-only)
    echo "Pulling stripe/sync-engine:v2…"
    docker pull stripe/sync-engine:v2
    ;;

  --no-pull)
    echo "Removing existing sync-engine container…"
    docker rm -f sync-engine 2>/dev/null || true
    echo "Starting sync-engine on port 4020…"
    docker run --rm -i \
      --name sync-engine \
      --network host \
      -e PORT=4020 \
      --env-file <(env | grep -E '^(STRIPE_|DATABASE_|STATE_|PG_|http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY)' 2>/dev/null || true) \
      stripe/sync-engine:v2
    ;;

  --pretty)
    echo "Pulling stripe/sync-engine:v2…"
    docker pull stripe/sync-engine:v2
    echo "Removing existing sync-engine container…"
    docker rm -f sync-engine 2>/dev/null || true
    echo "Starting sync-engine on port 4020…"
    docker run --rm -i \
      --name sync-engine \
      --network host \
      -e PORT=4020 \
      --env-file <(env | grep -E '^(STRIPE_|DATABASE_|STATE_|PG_|http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY)' 2>/dev/null || true) \
      stripe/sync-engine:v2 \
      2>&1 | node_modules/.pnpm/node_modules/.bin/pino-pretty
    ;;

  *)
    echo "Pulling stripe/sync-engine:v2…"
    docker pull stripe/sync-engine:v2
    echo "Removing existing sync-engine container…"
    docker rm -f sync-engine 2>/dev/null || true
    echo "Starting sync-engine on port 4020…"
    docker run --rm -i \
      --name sync-engine \
      --network host \
      -e PORT=4020 \
      --env-file <(env | grep -E '^(STRIPE_|DATABASE_|STATE_|PG_|http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY)' 2>/dev/null || true) \
      stripe/sync-engine:v2
    ;;
esac
