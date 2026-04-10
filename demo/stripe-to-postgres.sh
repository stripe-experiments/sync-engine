#!/usr/bin/env bash
# Sync Stripe → Postgres via the sync-engine CLI.
#
# Usage:
#   ./demo/stripe-to-postgres.sh
#   STRIPE_API_KEY=sk_live_... DATABASE_URL=postgresql://... ./demo/stripe-to-postgres.sh
#
# Env: STRIPE_API_KEY, DATABASE_URL (or POSTGRES_URL)
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="npx tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-bun}"
POSTGRES_URL="${DATABASE_URL:-${POSTGRES_URL:?Set DATABASE_URL or POSTGRES_URL}}"

echo "=== Stripe → Postgres ===" >&2
echo "Postgres: $POSTGRES_URL" >&2

# ── Option A: Simple shorthand (new sync command) ────────────────────────────
$RUN apps/engine/src/cli/index.ts sync \
  --stripe-api-key "$STRIPE_API_KEY" \
  --postgres-url "$POSTGRES_URL" \
  --streams products,prices,customers \
  --backfill-limit 10

# ── Option B: Full JSON pipeline (equivalent) ────────────────────────────────
# PIPELINE=$(node -e "console.log(JSON.stringify({
#   source: { type: 'stripe', stripe: { api_key: process.env.STRIPE_API_KEY, backfill_limit: 10 } },
#   destination: { type: 'postgres', postgres: { url: '$POSTGRES_URL', schema: 'public', port: 5432, batch_size: 100 } },
#   streams: [{ name: 'products' }, { name: 'prices' }, { name: 'customers' }],
# }))")
# $RUN apps/engine/src/cli/index.ts pipeline-sync --xPipeline "$PIPELINE"
