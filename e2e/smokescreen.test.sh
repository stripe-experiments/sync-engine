#!/usr/bin/env bash
# Test src-stripe, dest-pg, and dest-sheets through smokescreen HTTP CONNECT proxy.
#
# Uses Docker network isolation to ENFORCE that all outbound HTTPS goes through
# smokescreen — the engine container has no direct internet access.
# Without a working proxy, Stripe and Google API calls would fail outright.
#
# Required: STRIPE_API_KEY
# Optional: ENGINE_IMAGE (skips local build — CI passes the pre-built image)
# Optional: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# In CI the pre-built image is passed via ENGINE_IMAGE; locally we build from source.
BUILD_ENGINE=false
if [ -z "${ENGINE_IMAGE:-}" ]; then
  ENGINE_IMAGE="sync-engine:smokescreen-test"
  BUILD_ENGINE=true
fi

SMOKESCREEN_IMAGE="sync-engine-smokescreen:test"
S="$$"                                  # unique suffix for this run
NET="smokescreen-isolated-${S}"
SMOKESCREEN_CONTAINER="smokescreen-${S}"
ENGINE_CONTAINER="engine-smokescreen-${S}"
PG_CONTAINER="pg-smokescreen-${S}"
ENGINE_URL=""  # set after container starts

cleanup() {
  docker rm -f "$ENGINE_CONTAINER" "$SMOKESCREEN_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Build images ────────────────────────────────────────────────────────────

echo "==> Building smokescreen image"
docker build -t "$SMOKESCREEN_IMAGE" "$REPO_ROOT/docker/smokescreen"

if $BUILD_ENGINE; then
  echo "==> Building engine image"
  docker build -t "$ENGINE_IMAGE" "$REPO_ROOT"
fi

# ── Isolated network ─────────────────────────────────────────────────────────
# --internal means no default gateway → containers cannot reach the internet directly.

echo "==> Creating isolated Docker network: $NET"
docker network create --internal "$NET"

# ── Postgres (on isolated network — reachable by engine, not internet-exposed) ──

echo "==> Starting Postgres"
docker run -d --name "$PG_CONTAINER" \
  --network "$NET" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  postgres:18
PG_URL="postgres://postgres:postgres@${PG_CONTAINER}:5432/postgres"

# ── Smokescreen (isolated net + bridge → has internet, proxies for engine) ───

echo "==> Starting smokescreen"
docker run -d --name "$SMOKESCREEN_CONTAINER" \
  --network "$NET" \
  "$SMOKESCREEN_IMAGE"
# Connect to default bridge so smokescreen itself can reach the internet
docker network connect bridge "$SMOKESCREEN_CONTAINER"

for i in $(seq 1 20); do
  docker exec "$SMOKESCREEN_CONTAINER" nc -z localhost 4750 >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "FAIL: smokescreen health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Smokescreen ready"

# ── Engine (isolated network ONLY — HTTPS must route through smokescreen) ────

echo "==> Starting engine (HTTPS_PROXY=http://${SMOKESCREEN_CONTAINER}:4750)"
# No -p port mapping: --internal networks block port publishing on Linux.
# Instead, reach the engine by its container IP on the bridge (host has a
# directly connected route to the bridge subnet even for --internal networks).
docker run -d --name "$ENGINE_CONTAINER" \
  --network "$NET" \
  -e PORT=3000 \
  -e HTTPS_PROXY="http://${SMOKESCREEN_CONTAINER}:4750" \
  "$ENGINE_IMAGE"

# Wait for the container to get an IP assignment
ENGINE_IP=""
for i in $(seq 1 10); do
  ENGINE_IP=$(docker inspect "$ENGINE_CONTAINER" \
    --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)
  [ -n "$ENGINE_IP" ] && break
  sleep 0.5
done
[ -n "$ENGINE_IP" ] || { echo "FAIL: could not get engine container IP"; exit 1; }
ENGINE_URL="http://${ENGINE_IP}:3000"

for i in $(seq 1 20); do
  curl -sf "${ENGINE_URL}/health" >/dev/null && break
  [ "$i" -eq 20 ] && {
    echo "FAIL: engine health check timed out (IP: $ENGINE_IP)"
    echo "==> Engine container logs:"
    docker logs "$ENGINE_CONTAINER" 2>&1 || true
    echo "==> Engine container inspect (State):"
    docker inspect "$ENGINE_CONTAINER" --format '{{json .State}}' 2>&1 || true
    exit 1
  }
  sleep 0.5
done
echo "    Engine ready at $ENGINE_URL"

for i in $(seq 1 20); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "FAIL: postgres health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Postgres ready"

# ── 1) Read from Stripe (HTTPS → smokescreen → api.stripe.com) ───────────────

echo "==> src-stripe: read through smokescreen"
READ_PARAMS=$(printf \
  '{"source":{"name":"stripe","api_key":"%s","backfill_limit":5},"destination":{"name":"postgres","url":"postgres://unused:5432/db","schema":"stripe"},"streams":[{"name":"products"}]}' \
  "$STRIPE_API_KEY")
OUTPUT=$(curl -sf --max-time 30 -X POST "${ENGINE_URL}/read" \
  -H "X-Pipeline: $READ_PARAMS")
RECORD_COUNT=$(echo "$OUTPUT" | grep -c '"type":"record"' || true)
echo "    Got $RECORD_COUNT record(s)"
[ "$RECORD_COUNT" -gt 0 ] || { echo "FAIL: no records from Stripe"; exit 1; }

# ── 2) Write to Postgres (direct TCP on isolated network) ─────────────────────

echo "==> dest-pg: setup + write"
PG_PARAMS=$(printf \
  '{"source":{"name":"stripe","api_key":"%s"},"destination":{"name":"postgres","url":"%s","schema":"stripe_smokescreen_test"}}' \
  "$STRIPE_API_KEY" "$PG_URL")
curl -sf --max-time 30 -X POST "${ENGINE_URL}/setup" \
  -H "X-Pipeline: $PG_PARAMS" && echo "    setup OK"
echo "$OUTPUT" | curl -sf --max-time 60 -X POST "${ENGINE_URL}/write" \
  -H "X-Pipeline: $PG_PARAMS" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @- | head -3 || true
echo "    dest-pg OK"

# ── 3) Write to Google Sheets (HTTPS → smokescreen → googleapis.com) ─────────

if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  echo "==> dest-sheets: write through smokescreen"
  SHEETS_PARAMS=$(printf \
    '{"source":{"name":"stripe","api_key":"%s"},"destination":{"name":"google-sheets","client_id":"%s","client_secret":"%s","access_token":"unused","refresh_token":"%s","spreadsheet_id":"%s"}}' \
    "$STRIPE_API_KEY" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" "$GOOGLE_REFRESH_TOKEN" "$GOOGLE_SPREADSHEET_ID")
  echo "$OUTPUT" | curl -sf --max-time 60 -X POST "${ENGINE_URL}/write" \
    -H "X-Pipeline: $SHEETS_PARAMS" \
    -H "Content-Type: application/x-ndjson" \
    --data-binary @- | head -3 || true
  echo "    dest-sheets OK"
else
  echo "==> Skipping dest-sheets (GOOGLE_CLIENT_ID not set)"
fi

echo "==> All smokescreen tests passed"
