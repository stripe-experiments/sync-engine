# @stripe/sync-browser

A pre-bundled, browser-ready ESM package that runs Stripe Sync Engine directly in the browser using PGlite as the destination. Drop it into any web project (Vite, webpack, Next.js, plain `<script type="module">`, etc.) without needing the sync-engine monorepo or any workspace setup.

## Build the bundle

From the repo root:

```sh
pnpm install
pnpm --filter @stripe/sync-browser build
```

This produces a single self-contained file:

```
examples/browser-sync-lib/dist/index.js
examples/browser-sync-lib/dist/index.d.ts
```

All workspace packages (`@stripe/sync-engine`, `@stripe/sync-source-stripe`, `@stripe/sync-destination-postgres`, `@stripe/sync-protocol`) and node-only deps (`ws`, `pg`, `https-proxy-agent`, `node:*`) are inlined / shimmed for the browser. Only `@electric-sql/pglite` stays external, because it ships its own wasm and is best loaded by the consumer.

## Install into a different project

Pick one:

```sh
# Option A: install from a packed tarball (most portable)
cd examples/browser-sync-lib && pnpm pack
# in the other project:
npm install /abs/path/to/stripe-sync-browser-0.1.0.tgz @electric-sql/pglite

# Option B: install directly from the local folder
npm install /abs/path/to/sync-engine/examples/browser-sync-lib @electric-sql/pglite

# Option C: copy dist/index.js into your project and import it directly
```

## Usage

```ts
import { startSync } from '@stripe/sync-browser'

const controller = new AbortController()

await startSync({
  apiKey: 'sk_test_...',
  websocket: true,
  schema: 'stripe',
  batchSize: 50,
  databaseUrl: 'memory://',
  signal: controller.signal,
  onMessage: (msg) => console.log(msg),
})
```

### Options

| Field         | Default     | Description                                          |
| ------------- | ----------- | ---------------------------------------------------- |
| `apiKey`      | (required)  | Stripe secret key                                    |
| `websocket`   | `true`      | Use Stripe websocket for live tail                   |
| `schema`      | `'stripe'`  | Postgres schema name                                 |
| `batchSize`   | `50`        | Rows per upsert batch                                |
| `databaseUrl` | `'memory://'` | PGlite database URL (`memory://`, `idb://name`, etc) |
| `signal`      | —           | `AbortSignal` to cancel the sync                     |
| `onMessage`   | —           | Callback for every protocol message                  |

## CORS

Stripe's API does not allow direct browser requests by default. In dev, proxy `/stripe-api -> https://api.stripe.com` (see `examples/browser-sync/vite.config.ts`). In production you'll need your own proxy.
