#!/bin/bash
# Wrapper for Management API deployment (local bundle)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PACKAGE_DIR"
pnpm run build:edge-functions
pnpm exec tsx scripts/deploy-edge-functions.ts
