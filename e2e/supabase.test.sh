#!/usr/bin/env bash
# E2E test: Remote Supabase → supabase install → backfill sync
#
# Connects to a real Supabase project, cleans any prior installation,
# runs the standard `sync-engine supabase install` flow, waits for the
# backfill sync to land data, and verifies rows in Postgres.
#
# Required env:
#   STRIPE_API_KEY
#   E2E_SUPABASE_TOKEN     (personal access token / service-role)
#   E2E_SUPABASE_PROJECT   (project ref, e.g. oozizgzdedxsxtiiyqtt)
#
# Optional env:
#   SKIP_DELETE=1           skip final uninstall (leave data for inspection)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present
[ -f .env ] && set -a && source .env && set +a

: "${STRIPE_API_KEY:?Set STRIPE_API_KEY}"
: "${E2E_SUPABASE_TOKEN:?Set E2E_SUPABASE_TOKEN}"
: "${E2E_SUPABASE_PROJECT:?Set E2E_SUPABASE_PROJECT}"
SKIP_DELETE="${SKIP_DELETE:-}"

SUPABASE_ACCESS_TOKEN="$E2E_SUPABASE_TOKEN"
SUPABASE_PROJECT_REF="$E2E_SUPABASE_PROJECT"

MGMT_API="https://api.supabase.com"
CLI="node $ROOT/apps/engine/dist/cli/index.js"

# ── Helpers ───────────────────────────────────────────────────────────

run_sql() {
  local sql="$1"
  curl -sf --max-time 15 \
    -X POST "$MGMT_API/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$sql\"}"
}

# ── Cleanup on exit ───────────────────────────────────────────────────

cleanup() {
  local rc=$?
  echo ""
  echo "--- Cleanup ---"
  if [ -z "$SKIP_DELETE" ]; then
    echo "  Uninstalling..."
    $CLI supabase uninstall \
      --token "$SUPABASE_ACCESS_TOKEN" \
      --project "$SUPABASE_PROJECT_REF" 2>&1 | sed 's/^/  /' || true
  else
    echo "  SKIP_DELETE set — leaving installation in place"
  fi
  [ "$rc" -ne 0 ] && echo "  Test FAILED (exit $rc)"
  return "$rc"
}
trap cleanup EXIT

echo "==> Supabase project: $SUPABASE_PROJECT_REF"
echo "    Management API:   $MGMT_API"

# ── 1. Clean slate: uninstall any prior installation ──────────────────

echo ""
echo "==> Ensuring clean slate (uninstall if installed)"
$CLI supabase uninstall \
  --token "$SUPABASE_ACCESS_TOKEN" \
  --project "$SUPABASE_PROJECT_REF" 2>&1 | sed 's/^/  /' || true

# Give the project a moment to settle after uninstall
sleep 5

# ── 2. Install via the standard CLI flow ──────────────────────────────

echo ""
echo "==> Running: sync-engine supabase install"
$CLI supabase install \
  --token "$SUPABASE_ACCESS_TOKEN" \
  --project "$SUPABASE_PROJECT_REF" \
  --stripe-key "$STRIPE_API_KEY" \
  --worker-interval 30 \
  --rate-limit 20 \
  --backfill-concurrency 10
echo "  Install complete"

# ── 3. Wait for backfill sync to land data ────────────────────────────

echo ""
echo "==> Waiting for sync to complete (polling every 15s, up to 5 min)..."

SYNCED=0
for i in $(seq 1 20); do
  sleep 15

  RESULT=$(run_sql "SELECT count(*)::int AS n FROM stripe.subscriptions" 2>/dev/null) || true
  COUNT=$(echo "$RESULT" | node --input-type=module -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const rows = JSON.parse(d);
        console.log(rows[0]?.n ?? rows[0]?.count ?? 0);
      } catch { console.log(0); }
    })
  ")

  echo "  Poll $i/20: subscriptions=$COUNT (expecting 555)"

  if [ "$COUNT" -ge 555 ]; then
    SYNCED=1
    break
  fi
done

[ "$SYNCED" -eq 1 ] || { echo "FAIL: subscriptions did not reach 555 after 5 minutes"; exit 1; }

# ── 4. Verify exact row counts per table ──────────────────────────────

echo ""
echo "==> Verifying synced data (exact counts)"
FAILURES=0

parse_count() {
  node --input-type=module -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const rows = JSON.parse(d);
        console.log(rows[0]?.n ?? rows[0]?.count ?? 0);
      } catch { console.log(0); }
    })
  "
}

check_table() {
  local table="$1"
  local expected="$2"
  RESULT=$(run_sql "SELECT count(*)::int AS n FROM stripe.${table}" 2>/dev/null) || true
  COUNT=$(echo "$RESULT" | parse_count)
  if [ "$COUNT" -eq "$expected" ]; then
    printf "  %-30s %s  ✓\n" "$table" "$COUNT"
  else
    printf "  %-30s %s  ✗ (expected %s)\n" "$table" "$COUNT" "$expected"
    FAILURES=$((FAILURES + 1))
  fi
}

check_table charges                 1110
check_table checkout_sessions       555
check_table coupons                 555
check_table customers               555
check_table disputes                555
check_table invoices                1110
check_table payment_intents         1942
check_table plans                   833
check_table prices                  1110
check_table products                555
check_table refunds                 555
check_table setup_intents           555
check_table subscription_schedules  555
check_table subscriptions           555

[ "$FAILURES" -eq 0 ] || { echo "FAIL: $FAILURES table(s) had wrong counts"; exit 1; }

# ── 5. Check installation status via stripe-setup GET ─────────────────

echo ""
echo "==> Checking installation status"
STATUS_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/stripe-setup"
STATUS=$(curl -sf --max-time 15 "$STATUS_URL" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" 2>/dev/null) || true

echo "  $STATUS" | head -1

INSTALL_STATUS=$(echo "$STATUS" | node --input-type=module -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { console.log(JSON.parse(d).installation_status) } catch { console.log('unknown') }
  })
")
echo "  installation_status: $INSTALL_STATUS"
[ "$INSTALL_STATUS" = "installed" ] || echo "  WARNING: expected 'installed', got '$INSTALL_STATUS'"

echo ""
echo "=== Supabase install + sync test passed ==="
