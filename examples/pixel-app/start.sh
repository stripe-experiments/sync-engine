#!/usr/bin/env bash
# Loads optional local Metronome/Redis env without printing values.
# Defaults to ../.env from the repo root; override with ENV_FILE=/path/to/.env.
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
