#!/usr/bin/env bash
set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Large-scale sync benchmark
#
# Starts a deterministic Stripe mock server (30M records/stream)
# and drives `pipelines sync` against a Docker-deployed engine.
#
# Prerequisites:
#   - Docker Compose stack running (postgres + engine):
#       docker compose -f compose.yml -f compose.dev.yml up -d
#   - pnpm install && pnpm build
#
# Usage:
#   ./scripts/bench-large-sync.sh
#   MOCK_PORT=9222 ENGINE_URL=http://localhost:4010 ./scripts/bench-large-sync.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

source .envrc 2>/dev/null || true

# ── Configuration ─────────────────────────────────────────────

MOCK_PORT="${MOCK_PORT:-9111}"
ENGINE_URL="${ENGINE_URL:-http://localhost:4010}"
POSTGRES_URL="${BENCH_POSTGRES_URL:-postgresql://postgres:postgres@localhost:55432/postgres?sslmode=disable}"
POSTGRES_SCHEMA="${BENCH_POSTGRES_SCHEMA:-bench_mock}"
PIPELINE_ID="${BENCH_PIPELINE_ID:-pipe_bench_mock}"
STREAMS="${BENCH_STREAMS:-customers,products,prices}"
RATE_LIMIT="${BENCH_RATE_LIMIT:-1000}"

# Detect docker host IP for engine-in-Docker → host mock server
if command -v docker &>/dev/null; then
  DOCKER_HOST_IP=$(docker network inspect bridge \
    --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "")
fi
DOCKER_HOST_IP="${DOCKER_HOST_IP:-host.docker.internal}"
MOCK_BASE_URL="http://${DOCKER_HOST_IP}:${MOCK_PORT}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Large-Scale Sync Benchmark"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Mock server port:  $MOCK_PORT"
echo "  Mock base URL:     $MOCK_BASE_URL  (from engine container)"
echo "  Engine URL:        $ENGINE_URL"
echo "  Postgres URL:      $POSTGRES_URL"
echo "  Postgres schema:   $POSTGRES_SCHEMA"
echo "  Pipeline ID:       $PIPELINE_ID"
echo "  Streams:           $STREAMS"
echo "  Rate limit:        $RATE_LIMIT rps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Start mock server ─────────────────────────────────────────

echo "[bench] Starting mock server on port $MOCK_PORT..."
MOCK_PORT=$MOCK_PORT LOG_REQUESTS=0 \
  node --conditions bun --import tsx scripts/bench-mock-server.ts &
MOCK_PID=$!

cleanup() {
  echo ""
  echo "[bench] Stopping mock server (pid $MOCK_PID)..."
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for health
echo "[bench] Waiting for mock server health..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$MOCK_PORT/health" > /dev/null 2>&1; then
    echo "[bench] Mock server ready"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "[bench] ERROR: Mock server failed to start"
    exit 1
  fi
  sleep 0.5
done

# Quick sanity check
echo "[bench] Sanity check — first 2 customers:"
curl -s "http://localhost:$MOCK_PORT/v1/customers?limit=2" | python3 -m json.tool 2>/dev/null || \
  curl -s "http://localhost:$MOCK_PORT/v1/customers?limit=2"
echo ""

# ── Create pipeline if needed ─────────────────────────────────

# Check if pipeline already exists
alias pipelines='node --conditions bun --import tsx --no-warnings --use-env-proxy apps/service/src/bin/sync-service.ts pipelines'

if pipelines get "$PIPELINE_ID" --json 2>/dev/null | head -1 | grep -q '"id"'; then
  echo "[bench] Pipeline $PIPELINE_ID already exists"
else
  echo "[bench] Creating pipeline $PIPELINE_ID..."
  pipelines create "$PIPELINE_ID" \
    --stripe.api_key "sk_test_bench_mock_000000" \
    --stripe.base_url "$MOCK_BASE_URL" \
    --stripe.rate_limit "$RATE_LIMIT" \
    --postgres.url "$POSTGRES_URL" \
    --postgres.schema "$POSTGRES_SCHEMA" \
    --json 2>/dev/null || echo "[bench] Pipeline creation may have failed — will try sync anyway"
fi

# ── Run sync ──────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Starting sync: $STREAMS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Monitor mock server:  curl -s http://localhost:$MOCK_PORT/health | jq"
echo "  Monitor postgres:     psql '$POSTGRES_URL' -c 'SELECT count(*) FROM ${POSTGRES_SCHEMA}.customers'"
echo ""

# Run pipelines sync — override stripe source to point at mock
node --conditions bun --import tsx --no-warnings --use-env-proxy \
  apps/service/src/bin/sync-service.ts pipelines sync "$PIPELINE_ID" \
  --streams "$STREAMS" \
  --stripe.base_url "$MOCK_BASE_URL" \
  --stripe.api_key "sk_test_bench_mock_000000" \
  --stripe.rate_limit "$RATE_LIMIT" \
  --engine-url "$ENGINE_URL" \
  --reset-state \
  --plain
