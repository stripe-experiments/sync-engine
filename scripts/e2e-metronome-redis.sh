#!/usr/bin/env bash
# End-to-end test: Metronome → source-metronome → destination-redis
#
# Optional sandbox integration check for the full pipeline:
#   1. Backfill documented Metronome customer balance streams to Redis
#   2. Start webhook listener
#   3. Simulate customer usage (send events to Metronome ingest API)
#   4. Fire a webhook event → source re-fetches → Redis updates
#   5. Check Redis reflects a fresh customer net balance sync timestamp
#
# Prerequisites:
#   - METRONOME_API_TOKEN
#   - METRONOME_CUSTOMER_ID — caller-provided sandbox customer for ingest/webhook checks
#   - Redis (default localhost:56379 — matches compose.yml)
#
# Optional env:
#   REDIS_PORT (default 56379), WEBHOOK_PORT (default 4243), KEY_PREFIX (default sync:),
#   METRONOME_WEBHOOK_URL — optional public delivery URL to include in source setup metadata
#   METRONOME_WEBHOOK_SECRET — optional; signs the synthetic webhook if set
#   METRONOME_BASE_URL — only adds to connector config when set and not the public default
#
# Usage: METRONOME_API_TOKEN=… METRONOME_CUSTOMER_ID=… ./scripts/e2e-metronome-redis.sh
#
# Run from any directory; resolves paths from repo root (sync-engine/).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${METRONOME_API_TOKEN:?Set METRONOME_API_TOKEN}"
: "${METRONOME_CUSTOMER_ID:?Set METRONOME_CUSTOMER_ID}"

CUSTOMER_ID="${METRONOME_CUSTOMER_ID}"
REDIS_PORT="${REDIS_PORT:-56379}"
WEBHOOK_PORT="${WEBHOOK_PORT:-4243}"
KEY_PREFIX="${KEY_PREFIX:-sync:}"
METRONOME_API_ROOT="${METRONOME_BASE_URL:-https://api.metronome.com}"
METRONOME_API_ROOT="${METRONOME_API_ROOT%/}"

SOURCE_CONFIG="$(
  METRONOME_API_TOKEN="${METRONOME_API_TOKEN}" \
  METRONOME_WEBHOOK_URL_EFFECTIVE="${METRONOME_WEBHOOK_URL:-}" \
  METRONOME_WEBHOOK_SECRET_EFFECTIVE="${METRONOME_WEBHOOK_SECRET:-}" \
  SOURCE_METRONOME_BASE_URL_EFFECTIVE="${METRONOME_BASE_URL:-}" \
  WEBHOOK_PORT_EFFECTIVE="${WEBHOOK_PORT}" \
    python3 - <<'PY'
import json
import os

cfg = {
    "api_key": os.environ["METRONOME_API_TOKEN"],
    "webhook_port": int(os.environ["WEBHOOK_PORT_EFFECTIVE"]),
}
webhook_url = os.environ.get("METRONOME_WEBHOOK_URL_EFFECTIVE", "").strip()
if webhook_url:
    cfg["webhook_url"] = webhook_url
secret = os.environ.get("METRONOME_WEBHOOK_SECRET_EFFECTIVE", "").strip()
if secret:
    cfg["webhook_secret"] = secret
bu = os.environ.get("SOURCE_METRONOME_BASE_URL_EFFECTIVE", "").strip()
if bu and bu.rstrip("/") != "https://api.metronome.com":
    cfg["base_url"] = bu
print(json.dumps(cfg))
PY
)"

echo "=== E2E: Metronome → source-metronome → destination-redis ==="
echo ""

redis_cli() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -p "$REDIS_PORT" "$@"
  else
    docker compose exec -T redis redis-cli "$@"
  fi
}

assert_port_free() {
  python3 - "$WEBHOOK_PORT" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("::", port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
}

# Verify Redis is running
if ! redis_cli ping &>/dev/null; then
  echo "ERROR: Redis not running on port $REDIS_PORT. Run: docker compose up redis -d"
  exit 1
fi
if ! assert_port_free; then
  echo "ERROR: Webhook port $WEBHOOK_PORT is already in use. Stop the old pipeline or set WEBHOOK_PORT."
  exit 1
fi

redis_cli FLUSHDB >/dev/null

CATALOG_PATH="${CATALOG_PATH:-$ROOT/demo/metronome-redis-mvp-catalog.json}"
CATALOG="$(cat "$CATALOG_PATH")"
DEST_CONFIG="{\"url\":\"redis://localhost:$REDIS_PORT\",\"key_prefix\":\"$KEY_PREFIX\",\"batch_size\":1}"

PIPE_LOG="$(mktemp "${TMPDIR:-/tmp}/e2e-metronome-redis.XXXXXX")"
NET_BALANCE_KEY="${KEY_PREFIX}net_balance:$CUSTOMER_ID"

# Step 1: Start pipeline (backfill + webhook server)
echo "Step 1: Starting pipeline (backfill + webhook listener on port $WEBHOOK_PORT)..."
npx tsx --conditions bun packages/source-metronome/src/bin.ts read \
  --config "$SOURCE_CONFIG" --catalog "$CATALOG" 2>>"$PIPE_LOG" | \
npx tsx --conditions bun packages/destination-redis/src/bin.ts write \
  --config "$DEST_CONFIG" --catalog "$CATALOG" >/dev/null 2>>"$PIPE_LOG" &
PIPE_PID=$!
cleanup() {
  kill "$PIPE_PID" 2>/dev/null || true
  pkill -TERM -P "$PIPE_PID" 2>/dev/null || true
  rm -f "$PIPE_LOG" 2>/dev/null || true
}
trap cleanup EXIT
sleep 5
if ! kill -0 "$PIPE_PID" 2>/dev/null; then
  echo "ERROR: Sync pipeline exited early. Last log lines:"
  tail -80 "$PIPE_LOG" || true
  exit 1
fi

echo "Step 1: Backfill complete."
echo ""

# Step 2: Check initial state
echo "Step 2: Initial Redis state after backfill:"
BALANCE_BEFORE=$(redis_cli GET "$NET_BALANCE_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('balance', '<missing>'))")
SYNCED_BEFORE=$(redis_cli GET "$NET_BALANCE_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['_synced_at'])")
echo "  Net balance:    $BALANCE_BEFORE"
echo "  Synced at:      $SYNCED_BEFORE"
echo ""

# Step 3: Simulate customer usage
echo "Step 3: Simulating customer usage (5 API calls)..."
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "${METRONOME_API_ROOT}/v1/ingest" \
  -H "Authorization: Bearer $METRONOME_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_1\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_2\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_3\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_4\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_5\"}
  ]" >/dev/null
echo "  Sent 5 usage events to Metronome."
echo ""

sleep 2

# Step 4: Trigger webhook (simulates Metronome firing a credit event)
echo "Step 4: Firing credit.segment.end webhook..."

# Verify webhook server is listening
WEBHOOK_BODY="{\"type\":\"credit.segment.end\",\"id\":\"evt_e2e_$(date +%s)\",\"customer_id\":\"$CUSTOMER_ID\"}"
WEBHOOK_HEADERS=(-H "Content-Type: application/json")
if [[ -n "${METRONOME_WEBHOOK_SECRET:-}" ]]; then
  WEBHOOK_DATE="$(date -u '+%a, %d %b %Y %H:%M:%S GMT')"
  WEBHOOK_SIGNATURE="$(
    METRONOME_WEBHOOK_SECRET="${METRONOME_WEBHOOK_SECRET}" \
    WEBHOOK_DATE="${WEBHOOK_DATE}" \
    WEBHOOK_BODY="${WEBHOOK_BODY}" \
      python3 - <<'PY'
import hashlib
import hmac
import os

payload = f"{os.environ['WEBHOOK_DATE']}\n{os.environ['WEBHOOK_BODY']}".encode()
print(hmac.new(os.environ["METRONOME_WEBHOOK_SECRET"].encode(), payload, hashlib.sha256).hexdigest())
PY
  )"
  WEBHOOK_HEADERS+=(-H "Date: $WEBHOOK_DATE" -H "Metronome-Webhook-Signature: $WEBHOOK_SIGNATURE")
fi
if ! curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$WEBHOOK_PORT" \
  "${WEBHOOK_HEADERS[@]}" \
  -d "$WEBHOOK_BODY" | grep -q "200"; then
  echo "  WARNING: Webhook server returned non-200"
fi
sleep 5
echo "  Webhook processed."
echo ""

# Step 5: Verify Redis updated
echo "Step 5: Redis state after webhook refresh:"
BALANCE_AFTER=$(redis_cli GET "$NET_BALANCE_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('balance', '<missing>'))")
SYNCED_AFTER=$(redis_cli GET "$NET_BALANCE_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['_synced_at'])")
echo "  Net balance:    $BALANCE_AFTER"
echo "  Synced at:      $SYNCED_AFTER"
echo ""

# Step 6: Verify timestamp changed (proves webhook triggered a re-fetch)
if [ "$SYNCED_AFTER" -gt "$SYNCED_BEFORE" ]; then
  echo "✓ SUCCESS: Redis was updated by webhook (synced_at $SYNCED_BEFORE → $SYNCED_AFTER)"
else
  echo "✗ FAIL: Redis was NOT updated by webhook"
  echo " Pipeline log tail (stderr):"
  tail -80 "$PIPE_LOG" || true
  exit 1
fi

echo ""
echo "=== All Redis keys ==="
redis_cli KEYS "${KEY_PREFIX}*"
echo ""
echo "=== E2E complete ==="
