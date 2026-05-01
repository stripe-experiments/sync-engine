#!/usr/bin/env bash
# Poll webhook.site for new requests and forward them to a local webhook server.
# Usage: ./scripts/webhook-relay.sh <webhook-site-token> <local-url>
set -euo pipefail

TOKEN="${1:?Usage: webhook-relay.sh <webhook-site-token> <local-url>}"
TARGET="${2:-http://localhost:4243}"
POLL_INTERVAL_SECONDS="${WEBHOOK_RELAY_INTERVAL_SECONDS:-0.5}"
SEEN_FILE="$(mktemp)"
trap 'rm -f "$SEEN_FILE"' EXIT

echo "Relaying webhook.site/$TOKEN → $TARGET"
echo "Polling every $POLL_INTERVAL_SECONDS seconds..."

INITIAL_REQUESTS=$(curl -s "https://webhook.site/token/$TOKEN/requests?sorting=newest&per_page=100" 2>/dev/null)
INITIAL_REQUESTS="$INITIAL_REQUESTS" SEEN_FILE="$SEEN_FILE" python3 - <<'PY'
import json
import os
from pathlib import Path

seen_path = Path(os.environ["SEEN_FILE"])
try:
    data = json.loads(os.environ.get("INITIAL_REQUESTS", "{}"))
except json.JSONDecodeError:
    raise SystemExit(0)

with seen_path.open("a") as fh:
    for req in data.get("data", []):
        uuid = req.get("uuid")
        if uuid:
            fh.write(uuid + "\n")
PY

while true; do
  REQUESTS=$(curl -s "https://webhook.site/token/$TOKEN/requests?sorting=newest&per_page=5" 2>/dev/null)

  REQUESTS="$REQUESTS" TARGET="$TARGET" SEEN_FILE="$SEEN_FILE" python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

target = os.environ["TARGET"]
seen_path = Path(os.environ["SEEN_FILE"])
seen = set(seen_path.read_text().split()) if seen_path.exists() else set()

try:
    data = json.loads(os.environ.get("REQUESTS", "{}"))
except json.JSONDecodeError as exc:
    print(f"Could not parse webhook.site response: {exc}")
    raise SystemExit(0)

forward_headers = {
    "content-type",
    "date",
    "metronome-webhook-signature",
    "stripe-signature",
}

new_seen = []
for req in reversed(data.get("data", [])):
    uuid = req.get("uuid")
    if not uuid or uuid in seen:
        continue

    body = req.get("content") or ""
    headers = req.get("headers") or {}
    cmd = ["curl", "-sS", "-X", "POST", target]

    has_content_type = False
    for hdr_key, hdr_vals in headers.items():
        lower = hdr_key.lower()
        if lower not in forward_headers or not hdr_vals:
            continue
        val = hdr_vals[0] if isinstance(hdr_vals, list) else hdr_vals
        if lower == "content-type":
            has_content_type = True
        cmd.extend(["-H", f"{hdr_key}: {val}"])

    if not has_content_type:
        cmd.extend(["-H", "Content-Type: application/json"])

    cmd.extend(["--data-binary", "@-"])
    result = subprocess.run(cmd, input=body, capture_output=True, text=True)
    status = "ok" if result.returncode == 0 else f"exit {result.returncode}"
    print(f"Relayed {uuid[:8]}... ({status}) → {result.stdout[:120] or result.stderr[:120]}")
    new_seen.append(uuid)

if new_seen:
    with seen_path.open("a") as fh:
        for uuid in new_seen:
            fh.write(uuid + "\n")
PY

  sleep "$POLL_INTERVAL_SECONDS"
done
