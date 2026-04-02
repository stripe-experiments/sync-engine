#!/usr/bin/env bash
# E2E test: Ephemeral Supabase project → supabase install → backfill sync
#
# Creates a fresh Supabase project via the Management API, runs the standard
# `sync-engine supabase install` flow, waits for the backfill sync to land
# data, verifies rows in Postgres, then deletes the project.
#
# Required env:
#   STRIPE_SANDBOX_KEY
#   E2E_SUPABASE_TOKEN     (personal access token, starts with sbp_)
#   E2E_SUPABASE_ORG       (organization ID for project creation)
#
# Optional env:
#   SKIP_DELETE=1           skip project deletion (leave for inspection)
#   MAX_TEST_PROJECTS=8     safety cap on concurrent e2e projects
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f .env ] && set -a && source .env && set +a

: "${STRIPE_SANDBOX_KEY:?Set STRIPE_SANDBOX_KEY}"
: "${E2E_SUPABASE_TOKEN:?Set E2E_SUPABASE_TOKEN}"
: "${E2E_SUPABASE_ORG:?Set E2E_SUPABASE_ORG}"

SKIP_DELETE="${SKIP_DELETE:-}"
MAX_TEST_PROJECTS="${MAX_TEST_PROJECTS:-8}"
PROJECT_PREFIX="github-ci-spawned"
PROJECT_NAME="${PROJECT_PREFIX}-${GITHUB_RUN_ID:-local-$(date +%s)}"
PROJECT_REGION="us-east-1"
DB_PASS="e2e-$(openssl rand -hex 16)"

MGMT_API="https://api.supabase.com"
CLI="node $ROOT/apps/engine/dist/cli/index.js"
PROJECT_REF=""

# ── Helpers ───────────────────────────────────────────────────────────

parse_json_field() {
  local field="$1"
  node --input-type=module -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { console.log(JSON.parse(d)['${field}'] ?? ''); } catch { console.log(''); }
    })
  "
}

run_sql() {
  local sql="$1"
  curl -sf --max-time 15 \
    -X POST "$MGMT_API/v1/projects/$PROJECT_REF/database/query" \
    -H "Authorization: Bearer $E2E_SUPABASE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$sql\"}"
}

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

# ── Cleanup on exit ───────────────────────────────────────────────────

cleanup() {
  local rc=$?
  echo ""
  echo "--- Cleanup ---"

  if [ -n "$PROJECT_REF" ]; then
    if [ -z "$SKIP_DELETE" ]; then
      echo "  Uninstalling sync..."
      $CLI supabase uninstall \
        --token "$E2E_SUPABASE_TOKEN" \
        --project "$PROJECT_REF" 2>&1 | sed 's/^/  /' || true

      echo "  Deleting project $PROJECT_REF..."
      curl -sf -X DELETE "$MGMT_API/v1/projects/$PROJECT_REF" \
        -H "Authorization: Bearer $E2E_SUPABASE_TOKEN" || true
      echo "  Project deleted."
    else
      echo "  SKIP_DELETE set — leaving project $PROJECT_REF alive"
    fi
  fi

  [ "$rc" -ne 0 ] && echo "  Test FAILED (exit $rc)"
  return "$rc"
}
trap cleanup EXIT

# ── 0. Safety check: don't exceed MAX_TEST_PROJECTS ──────────────────

echo "==> Checking for existing e2e test projects (max $MAX_TEST_PROJECTS)..."

PROJECTS=$(curl -sf "$MGMT_API/v1/projects" \
  -H "Authorization: Bearer $E2E_SUPABASE_TOKEN")

TEST_COUNT=$(echo "$PROJECTS" | node --input-type=module -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    const projects = JSON.parse(d);
    const active = projects.filter(p =>
      p.name.startsWith('${PROJECT_PREFIX}-') &&
      p.status !== 'REMOVED'
    );
    active.forEach(p => console.error('  ' + p.name + ' (' + p.id + ') status=' + p.status));
    console.log(active.length);
  })
")

echo "  Found $TEST_COUNT active e2e project(s)"
if [ "$TEST_COUNT" -ge "$MAX_TEST_PROJECTS" ]; then
  echo "FAIL: $TEST_COUNT e2e projects already exist (limit $MAX_TEST_PROJECTS)."
  echo "      Clean up stale projects before running more tests."
  exit 1
fi

# ── 1. Create ephemeral Supabase project ──────────────────────────────

echo ""
echo "==> Creating Supabase project: $PROJECT_NAME (region: $PROJECT_REGION)"

CREATE_RESP=$(curl -sf -X POST "$MGMT_API/v1/projects" \
  -H "Authorization: Bearer $E2E_SUPABASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$PROJECT_NAME\",
    \"organization_id\": \"$E2E_SUPABASE_ORG\",
    \"region\": \"$PROJECT_REGION\",
    \"db_pass\": \"$DB_PASS\"
  }")

PROJECT_REF=$(echo "$CREATE_RESP" | parse_json_field "id")

if [ -z "$PROJECT_REF" ]; then
  echo "FAIL: Could not create project. Response:"
  echo "$CREATE_RESP"
  exit 1
fi

echo "  Project ref: $PROJECT_REF"

# ── 2. Wait for project to become ACTIVE_HEALTHY ─────────────────────

echo ""
echo "==> Waiting for project to become ACTIVE_HEALTHY (polling every 10s, up to 5 min)..."

PROJECT_STATUS=""
for i in $(seq 1 30); do
  sleep 10

  PROJECT_STATUS=$(curl -sf "$MGMT_API/v1/projects/$PROJECT_REF" \
    -H "Authorization: Bearer $E2E_SUPABASE_TOKEN" \
    | parse_json_field "status") || true

  echo "  Poll $i/30: status=$PROJECT_STATUS"

  if [ "$PROJECT_STATUS" = "ACTIVE_HEALTHY" ]; then
    break
  fi
done

if [ "$PROJECT_STATUS" != "ACTIVE_HEALTHY" ]; then
  echo "FAIL: project never became ACTIVE_HEALTHY (last status: $PROJECT_STATUS)"
  exit 1
fi

echo "  Project is ready."
echo "    Management API:   $MGMT_API"
echo "    Project URL:      https://${PROJECT_REF}.supabase.co"

# ── 3. Install via the standard CLI flow ──────────────────────────────

echo ""
echo "==> Running: sync-engine supabase install"
$CLI supabase install \
  --token "$E2E_SUPABASE_TOKEN" \
  --project "$PROJECT_REF" \
  --stripe-key "$STRIPE_SANDBOX_KEY" \
  --worker-interval 30 \
  --rate-limit 20 \
  --backfill-concurrency 10
echo "  Install complete"

# ── 4. Wait for backfill sync to land data ────────────────────────────

echo ""
echo "==> Waiting for sync to complete (polling every 15s, up to 5 min)..."

SYNCED=0
for i in $(seq 1 20); do
  sleep 15

  RESULT=$(run_sql "SELECT count(*)::int AS n FROM stripe.subscriptions" 2>/dev/null) || true
  COUNT=$(echo "$RESULT" | parse_count)

  echo "  Poll $i/20: subscriptions=$COUNT (expecting 555)"

  if [ "$COUNT" -ge 555 ]; then
    SYNCED=1
    break
  fi
done

[ "$SYNCED" -eq 1 ] || { echo "FAIL: subscriptions did not reach 555 after 5 minutes"; exit 1; }

# ── 5. Verify exact row counts per table ──────────────────────────────

echo ""
echo "==> Verifying synced data (exact counts)"
FAILURES=0

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

# ── 6. Check installation status via stripe-setup GET ─────────────────

echo ""
echo "==> Checking installation status"
STATUS_URL="https://${PROJECT_REF}.supabase.co/functions/v1/stripe-setup"
STATUS=$(curl -sf --max-time 15 "$STATUS_URL" \
  -H "Authorization: Bearer $E2E_SUPABASE_TOKEN" 2>/dev/null) || true

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
