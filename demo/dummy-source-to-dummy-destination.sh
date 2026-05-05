#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./dummy-source.sh | cat
