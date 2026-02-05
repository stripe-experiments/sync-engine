#!/bin/bash
# Setup script for Stripe Sync with local Supabase Docker
#
# This script:
#   1. Installs edge functions to volumes/functions
#   2. Starts Supabase services
#   3. Runs database migrations
#
# Usage:
#   ./setup-stripe-sync.sh [--stripe-key sk_test_xxx]
#
# Environment variables:
#   STRIPE_SECRET_KEY - Your Stripe secret key (required)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Parse arguments
STRIPE_KEY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --stripe-key)
      STRIPE_KEY="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Get Stripe key from argument, env, or prompt
if [ -z "$STRIPE_KEY" ]; then
  STRIPE_KEY="${STRIPE_SECRET_KEY:-}"
fi

if [ -z "$STRIPE_KEY" ]; then
  # Check if it's in the .env file
  if [ -f ".env" ] && grep -q "^STRIPE_SECRET_KEY=" .env; then
    STRIPE_KEY=$(grep "^STRIPE_SECRET_KEY=" .env | cut -d'=' -f2-)
  fi
fi

if [ -z "$STRIPE_KEY" ]; then
  echo "Error: STRIPE_SECRET_KEY is required"
  echo ""
  echo "Provide it via:"
  echo "  - --stripe-key argument"
  echo "  - STRIPE_SECRET_KEY environment variable"
  echo "  - STRIPE_SECRET_KEY in .env file"
  exit 1
fi

echo "🚀 Setting up Stripe Sync for local Supabase..."
echo ""

# Step 1: Ensure .env file has STRIPE_SECRET_KEY
if [ -f ".env" ]; then
  if grep -q "^STRIPE_SECRET_KEY=" .env; then
    # Update existing value
    sed -i.bak "s|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=${STRIPE_KEY}|" .env
    rm -f .env.bak
    echo "✓ Updated STRIPE_SECRET_KEY in .env"
  else
    # Append to file
    echo "" >> .env
    echo "# Stripe Sync" >> .env
    echo "STRIPE_SECRET_KEY=${STRIPE_KEY}" >> .env
    echo "✓ Added STRIPE_SECRET_KEY to .env"
  fi
else
  echo "Error: .env file not found. Copy .env.example to .env first."
  exit 1
fi

# Step 2: Install edge functions using the CLI (from project root)
echo ""
echo "📦 Installing edge functions..."
cd ../..  # Go to project root

# Check if the CLI is built
if [ ! -f "packages/sync-engine/dist/cli/index.js" ]; then
  echo "  Building sync-engine package..."
  pnpm install
  pnpm run -r build
fi

# Run the local install (non-interactive, functions only)
# This copies edge functions to volumes/functions
echo "  Copying edge functions to volumes/functions..."
npx stripe-experiment-sync supabase install --local --docker-path docker/supabase --stripe-key "$STRIPE_KEY" << EOF
n
EOF

cd docker/supabase

# Step 3: Start Supabase services
echo ""
echo "🐳 Starting Supabase services..."
docker compose up -d

# Step 4: Wait for database to be healthy
echo ""
echo "⏳ Waiting for database to be ready..."
until docker compose exec -T db pg_isready -U postgres 2>/dev/null; do
  echo "  Database not ready, waiting..."
  sleep 3
done
echo "✓ Database is ready"

# Step 5: Run migrations (database is exposed on port 54322)
echo ""
echo "📊 Running database migrations..."
cd ../..  # Go to project root

# Get database password from .env
DB_PASSWORD=$(grep "^POSTGRES_PASSWORD=" docker/supabase/.env | cut -d'=' -f2-)

npx stripe-experiment-sync migrate --database-url "postgresql://postgres:${DB_PASSWORD}@localhost:54322/postgres"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Stripe Sync Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Supabase Studio: http://localhost:8000"
echo "  Edge Functions:"
echo "    - Setup:   http://localhost:8000/functions/v1/stripe-setup"
echo "    - Webhook: http://localhost:8000/functions/v1/stripe-webhook"
echo "    - Worker:  http://localhost:8000/functions/v1/stripe-worker"
echo ""
echo "  To receive Stripe webhooks locally, use Stripe CLI:"
echo "    stripe listen --forward-to localhost:8000/functions/v1/stripe-webhook"
echo ""
