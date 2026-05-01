#!/usr/bin/env bash
# Long-running Sync Engine: Metronome → source-metronome (backfill + webhook) → destination-redis
#
# Run from anywhere; changes cwd to repo root (sync-engine/).
#
# Env:
#   METRONOME_API_TOKEN (required)
#   METRONOME_CUSTOMER_ID — only needed by PixelDraw/e2e; pipeline syncs whatever Metronome returns
#   REDIS_PORT (default 56379), WEBHOOK_PORT (default 4243), KEY_PREFIX (default sync:)
#   METRONOME_WEBHOOK_URL — optional public delivery URL, e.g. https://webhook.site/<token>
#   METRONOME_WEBHOOK_SECRET — optional; enables Metronome HMAC verification
#   METRONOME_BASE_URL — passed to connector when set and not the public default
#
# After backfill completes, webhook listener is POST http://127.0.0.1:$WEBHOOK_PORT
# Simulate Metronome: curl -s -X POST "http://127.0.0.1:$WEBHOOK_PORT" -H "Content-Type: application/json" \
#   -d '{"type":"credit.segment.end","id":"evt_demo","customer_id":"<CUSTOMER_ID>"}'
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${METRONOME_API_TOKEN:?Set METRONOME_API_TOKEN}"

REDIS_PORT="${REDIS_PORT:-56379}"
WEBHOOK_PORT="${WEBHOOK_PORT:-4243}"
KEY_PREFIX="${KEY_PREFIX:-sync:}"
METRONOME_API_ROOT="${METRONOME_BASE_URL:-https://api.metronome.com}"
METRONOME_API_ROOT="${METRONOME_API_ROOT%/}"

CATALOG_PATH="${CATALOG_PATH:-$ROOT/demo/metronome-redis-mvp-catalog.json}"

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

DEST_CONFIG="{\"url\":\"redis://localhost:$REDIS_PORT\",\"key_prefix\":\"$KEY_PREFIX\",\"batch_size\":1}"

redis_cli_ping() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -p "$REDIS_PORT" ping
  else
    docker compose exec -T redis redis-cli ping
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

echo "=== Metronome → Redis pipeline (foreground) ==="
echo " Repo:    $ROOT"
echo " Redis:   localhost:$REDIS_PORT  (compose: docker compose up redis -d)"
echo " Webhook: http://127.0.0.1:$WEBHOOK_PORT (POST JSON Metronome events)"
if [[ -n "${METRONOME_WEBHOOK_URL:-}" ]]; then
  echo " Public:  $METRONOME_WEBHOOK_URL"
  if [[ "$METRONOME_WEBHOOK_URL" =~ ^https://webhook\.site/([^/?#]+) ]]; then
    echo " Relay:   ./scripts/webhook-relay.sh ${BASH_REMATCH[1]} http://127.0.0.1:$WEBHOOK_PORT"
  fi
fi
echo " Catalog: $CATALOG_PATH"
echo ""

if ! redis_cli_ping &>/dev/null; then
  echo "ERROR: Redis not reachable. Start with: docker compose up redis -d"
  exit 1
fi
if ! assert_port_free; then
  echo "ERROR: Webhook port $WEBHOOK_PORT is already in use. Stop the old pipeline or set WEBHOOK_PORT."
  exit 1
fi

echo "Streaming sync output to this terminal (^C to stop)..."
exec npx tsx --conditions bun packages/source-metronome/src/bin.ts read \
  --config "$SOURCE_CONFIG" \
  --catalog "$(cat "$CATALOG_PATH")" \
  | npx tsx --conditions bun packages/destination-redis/src/bin.ts write \
  --config "$DEST_CONFIG" \
  --catalog "$(cat "$CATALOG_PATH")"
