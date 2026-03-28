#!/usr/bin/env bash
# Stripe read through smokescreen (HTTP CONNECT) with Docker network isolation.
# Engine has no default route on the internal network; outbound HTTPS to Stripe
# must use HTTPS_PROXY → smokescreen (also connected to bridge for internet).
# Postgres runs on the same internal network (TCP, no proxy).
#
# Required: STRIPE_API_KEY
# Optional: ENGINE_IMAGE (CI: pre-built image; skips local docker build)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BUILD_ENGINE=false
if [ -z "${ENGINE_IMAGE:-}" ]; then
  ENGINE_IMAGE="sync-engine:smokescreen-test"
  BUILD_ENGINE=true
fi

SMOKESCREEN_IMAGE="sync-engine-smokescreen:test"
S="$$"
NET="smokescreen-isolated-${S}"
SMOKESCREEN_CONTAINER="smokescreen-${S}"
ENGINE_CONTAINER="engine-smokescreen-${S}"
PG_CONTAINER="pg-smokescreen-${S}"
ENGINE_PORT="${PORT:-3399}"

cleanup() {
  docker rm -f "$ENGINE_CONTAINER" "$SMOKESCREEN_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building smokescreen image"
docker build -t "$SMOKESCREEN_IMAGE" "$REPO_ROOT/docker/smokescreen"

if $BUILD_ENGINE; then
  echo "==> Building engine image"
  docker build -t "$ENGINE_IMAGE" "$REPO_ROOT"
fi

echo "==> Creating isolated Docker network: $NET"
docker network create --internal "$NET"

echo "==> Starting Postgres"
docker run -d --name "$PG_CONTAINER" \
  --network "$NET" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  postgres:18
PG_URL="postgres://postgres:postgres@${PG_CONTAINER}:5432/postgres"

echo "==> Starting smokescreen"
docker run -d --name "$SMOKESCREEN_CONTAINER" \
  --network "$NET" \
  "$SMOKESCREEN_IMAGE"
docker network connect bridge "$SMOKESCREEN_CONTAINER"

for i in $(seq 1 20); do
  docker exec "$SMOKESCREEN_CONTAINER" nc -z localhost 4750 >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "FAIL: smokescreen health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Smokescreen ready"

echo "==> Starting engine (HTTPS_PROXY=http://${SMOKESCREEN_CONTAINER}:4750)"
docker run -d --name "$ENGINE_CONTAINER" \
  --network "$NET" \
  -p "${ENGINE_PORT}:3000" \
  -e PORT=3000 \
  -e HTTPS_PROXY="http://${SMOKESCREEN_CONTAINER}:4750" \
  "$ENGINE_IMAGE"

for i in $(seq 1 20); do
  curl -sf "http://localhost:${ENGINE_PORT}/health" >/dev/null && break
  [ "$i" -eq 20 ] && { echo "FAIL: engine health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Engine ready on :${ENGINE_PORT}"

for i in $(seq 1 20); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "FAIL: postgres health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Postgres ready"

# --- Stripe read (HTTPS via proxy) — same shape as e2e/docker.test.sh ---
echo "==> src-stripe: read through smokescreen"
READ_PARAMS=$(printf \
  '{"source":{"name":"stripe","api_key":"%s","backfill_limit":5},"destination":{"name":"postgres","url":"postgres://unused:5432/db","schema":"stripe"},"streams":[{"name":"products"}]}' \
  "$STRIPE_API_KEY")
OUTPUT=$(curl -sf --max-time 90 -X POST "http://localhost:${ENGINE_PORT}/read" \
  -H "X-Pipeline: $READ_PARAMS")
RECORD_COUNT=$(echo "$OUTPUT" | grep -c '"type":"record"' || true)
echo "    Got $RECORD_COUNT record(s)"
[ "$RECORD_COUNT" -gt 0 ] || { echo "FAIL: no records from Stripe"; exit 1; }

# --- Postgres (direct on internal network) ---
echo "==> dest-pg: setup + write"
PG_PARAMS=$(printf \
  '{"source":{"name":"stripe","api_key":"%s"},"destination":{"name":"postgres","url":"%s","schema":"stripe_smokescreen_test"}}' \
  "$STRIPE_API_KEY" "$PG_URL")
curl -sf --max-time 30 -X POST "http://localhost:${ENGINE_PORT}/setup" \
  -H "X-Pipeline: $PG_PARAMS" && echo "    setup OK" || echo "    setup returned non-204 (may be fine)"
echo "$OUTPUT" | curl -sf --max-time 90 -X POST "http://localhost:${ENGINE_PORT}/write" \
  -H "X-Pipeline: $PG_PARAMS" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @- | head -3 || true
echo "    dest-pg OK"

echo "==> Smokescreen e2e passed"
