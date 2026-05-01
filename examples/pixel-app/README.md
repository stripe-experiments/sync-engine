# PixelDraw Metronome + Redis Demo

## Run The Demo

From the `sync-engine` repo root:

```sh
docker compose -p demo -f demo/compose.metronome-redis.yml down --remove-orphans

METRONOME_WEBHOOK_URL="https://webhook.site/<token>" \
docker compose --env-file ../.env -p demo -f demo/compose.metronome-redis.yml up --build
```

In a second terminal, relay webhook.site deliveries into the local Sync Engine listener:

```sh
cd /Users/kdhillon/stripe/metronome-redis-investigation/sync-engine

WEBHOOK_RELAY_INTERVAL_SECONDS=0.5 \
./scripts/webhook-relay.sh <token> http://127.0.0.1:4244
```

In a third terminal, start PixelDraw:

```sh
cd /Users/kdhillon/stripe/metronome-redis-investigation/sync-engine/examples/pixel-app

PORT=4000 npm start
```

Open the app:

```sh
open http://localhost:4000
```

## Test Flow

1. Start with PixelDraw open and confirm the credit balance is coming from Redis.
2. In Metronome, create or edit a credit for the demo customer.
3. Confirm the notification arrives in webhook.site.
4. Confirm the relay forwards it to the local Sync Engine listener on `:4244`.
5. Confirm Sync Engine refreshes Metronome resources and writes updated `sync:*` keys into Redis.
6. Confirm PixelDraw auto-updates from Redis within a few seconds.
7. Draw a pixel once the balance is above the threshold. Server logs should show Redis reads for the draw gate and Metronome `/v1/ingest` writes for usage.

## Useful Knobs

- `MIN_CREDITS_TO_DRAW=60` controls the balance required before drawing is allowed.
- `PIXEL_USAGE_EVENTS_PER_DRAW=100` controls how many `api_call` usage events one pixel sends.
- `METRONOME_INGEST_BATCH_DELAY_MS=0` can be raised if Metronome rate limits usage ingest.
- `NO_COLOR=1` disables colored server logs.

## Validation

For a lightweight local check after code changes:

```sh
cd /Users/kdhillon/stripe/metronome-redis-investigation/sync-engine/examples/pixel-app
npm install
node --check server.js
```

For the packaged sidecar check:

```sh
cd /Users/kdhillon/stripe/metronome-redis-investigation/sync-engine
docker compose --env-file ../.env -p demo -f demo/compose.metronome-redis.yml config
```
