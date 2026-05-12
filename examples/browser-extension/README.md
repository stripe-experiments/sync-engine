# Stripe Sync Browser Extension

A Chrome MV3 extension that runs the sync engine and PGlite entirely in the browser, syncing Stripe data from `api.stripe.com` into a persistent in-browser Postgres (IndexedDB-backed).

Built on top of [`examples/browser-sync`](../browser-sync) and the PGlite destination introduced in upstream PR stripe/sync-engine#327.

## Architecture

```
content (stripe.com / dashboard.stripe.com)
   │  chrome.runtime.sendMessage  → background
   ▼
background SW
   │  chrome.sidePanel.setOptions     (per-tab enable)
   │  chrome.offscreen.createDocument (one offscreen doc)
   ▼
offscreen document
   │  PGlite (idb://stripe-sync)
   │  sync engine + source-stripe + destination-postgres/pglite
   ▼
api.stripe.com   (host_permissions: no CORS)
```

The offscreen document owns the PGlite instance and the engine. The background SW is a thin router. The side panel UI sends `offscreen:*` messages and receives `progress` / `status` broadcasts.

## Build

```sh
pnpm install
pnpm --filter @stripe/sync-destination-postgres build
pnpm --filter @stripe/sync-engine build
pnpm --filter @stripe/sync-extension build
```

Output: `dist/`.

## Load (manual)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked**, pick `examples/browser-extension/dist`.
4. Pin the extension from the toolbar.

## Smoke test

1. Click the extension icon → **Open settings**.
2. Paste a Stripe restricted key (`rk_test_…` recommended) and hit **Save**.
3. Open `https://dashboard.stripe.com/` in a tab.
4. Click the extension icon — the side panel should open.
5. Click **Start sync**. Progress lines stream in.
6. Once status is `done` (or after backfill begins for a non-trivial account), run:

   ```sql
   SELECT id, email, created FROM stripe.customers LIMIT 10;
   ```

7. Rows return from the local PGlite database.

## Key files

- [manifest.config.ts](manifest.config.ts) — MV3 manifest: side panel, offscreen, host_permissions for `*.stripe.com`.
- [src/background.ts](src/background.ts) — Lifecycle of side panel + offscreen document; thin message router.
- [src/offscreen.ts](src/offscreen.ts) — Hosts the engine and PGlite. Handles `start_sync`, `stop_sync`, `run_query`, `clear_db`.
- [src/lib/sync.ts](src/lib/sync.ts) — Engine wiring (adapted from `examples/browser-sync/src/lib/sync.ts`); writes state into `chrome.storage.local`.
- [src/sidepanel/App.tsx](src/sidepanel/App.tsx) — Status feed + SQL console.
- [src/options/App.tsx](src/options/App.tsx) — API key entry.
- [vite.config.ts](vite.config.ts) — Reuses node shims from `../browser-sync/src/shims/*` plus extra resolves for `stream-browserify/promises` (PGlite) and absolute polyfill paths.

## Constraints

- **Chrome only**, version 116+ (needs `chrome.offscreen` + `chrome.sidePanel`). Firefox does not yet implement `chrome.offscreen`.
- **API key is a secret on the user's machine.** Prefer restricted keys with read-only scopes. The key is stored in `chrome.storage.local`, scoped to the extension's origin.
- **Backfills survive SW restarts** because state lives in IndexedDB + `chrome.storage.local`. They do not survive a fresh database (clear DB) or revoked key.
- **WebSocket live mode is disabled** by default to keep the SW lifecycle simple. Re-enable in [src/lib/sync.ts](src/lib/sync.ts) by setting `websocket: true` once you've verified backfill.
