#!/usr/bin/env bash
# Loads optional Metronome/Redis env from parent investigation .env
# (sync-engine/../.env) without printing values.
# Override with ENV_FILE=/path/to/.env.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SYNC_ENGINE_ROOT="$(cd "$HERE/../.." && pwd)"
DEFAULT_PARENT_ENV="$(cd "$SYNC_ENGINE_ROOT/.." && pwd)/.env"
ENV_FILE="${ENV_FILE:-$DEFAULT_PARENT_ENV}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=1090
  source "$ENV_FILE"
  set +a
fi

exec node "$HERE/server.js" "$@"
