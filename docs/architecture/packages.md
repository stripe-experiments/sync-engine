# Monorepo Packages

The sync engine decomposes into packages along the architecture's isolation boundaries. The rule is simple: **sources and destinations never depend on each other.** They only depend on the core protocol and approved shared utilities.

```
packages/
├── protocol/                 ← core protocol (message types, interfaces, Zod schemas)
├── openapi/                  ← Stripe OpenAPI spec fetching and parsing
├── logger/                   ← structured logging (pino) + progress UI (ink)
├── source-stripe/            ← Stripe API source connector
├── destination-postgres/     ← Postgres destination connector
├── destination-google-sheets/← Google Sheets destination connector
├── state-postgres/           ← Postgres state store (migration runner + embedded migrations)
├── util-postgres/            ← shared Postgres utilities (upsert, rate limiter)
├── hono-zod-openapi/         ← Hono + zod-openapi integration for spec generation
├── test-utils/               ← shared test helpers (servers, seeds, Postgres fixtures)
└── ts-cli/                   ← generic TypeScript module CLI runner (private)
apps/
├── engine/                   ← sync engine library + stateless CLI + HTTP API
├── service/                  ← stateful service (pipeline management, Temporal workflows)
├── dashboard/                ← React web UI for pipeline management
├── visualizer/               ← Next.js data visualization tool
└── supabase/                 ← Supabase edge functions (Deno runtime)
```

## Dependency graph

```
  ┌────────────────┐       ┌──────────────┐  ┌──────────────┐  ┌──────────┐
  │   protocol     │       │state-postgres │  │ util-postgres │  │  logger  │
  │ (types+schemas)│       │  (pg only)    │  │  (pg only)    │  │  (pino)  │
  └───────┬────────┘       └──────────────┘  └──────────────┘  └──────────┘
          │                   depends on           depends on      shared by
    ┌─────┼───────────┐       util-postgres         logger        most pkgs
    │     │           │
 sources  │    destinations
 (stripe) │    (pg, sheets)
    │     │           │
    │  apps/engine    │       ← engine + connector loader + pipeline utils + CLI + API
    │  (protocol,     │         (depends on protocol, state-postgres, hono-zod-openapi)
    │   connectors)   │
    │     │           │
    │  apps/service   │       ← pipeline management + webhook ingress via Temporal
    │  (engine,       │         (depends on engine, Temporal SDK)
    │   temporal)     │
    │     │           │
    │     │     NO ARROWS BETWEEN
    │     │     SOURCES ↔ DESTINATIONS
    │     │
    ├─ apps/dashboard ─→ React SPA consuming service API via openapi-fetch
    ├─ apps/visualizer ─→ Next.js app for data exploration
    └─ apps/supabase  ─→ protocol + source-stripe + destination-postgres
                          + state-postgres + apps/engine
```

### Canonical dependency layering

| Layer          | Package                                                              | Depends on                                                              |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Core           | `protocol`                                                           | `zod`, `citty`, `ix`                                                    |
| Shared utils   | `logger`                                                             | `pino`, `ink`, `react`; peer: `protocol`                                |
| Shared utils   | `openapi`                                                            | `zod`                                                                   |
| Shared utils   | `util-postgres`                                                      | `logger`, `pg`                                                          |
| Shared utils   | `hono-zod-openapi`                                                   | `hono`, `zod`, `zod-openapi`                                            |
| Connectors     | `source-stripe`, `destination-postgres`, `destination-google-sheets` | `protocol` + approved shared utilities (`logger`, `openapi`, `util-pg`) |
| State          | `state-postgres`                                                     | `util-postgres`, `logger`, `pg`                                         |
| Engine + CLI   | `apps/engine`                                                        | `protocol`, `state-postgres`, connectors, `hono-zod-openapi`, `logger`  |
| Service        | `apps/service`                                                       | `apps/engine`, Temporal SDK                                             |
| Frontend       | `apps/dashboard`                                                     | `openapi-fetch` (consumes service API)                                  |
| Frontend       | `apps/visualizer`                                                    | `next`, `source-stripe`, `pglite`                                       |
| Integration    | `apps/supabase`                                                      | `protocol`, `source-stripe`, `destination-postgres`, `apps/engine`      |
| Test infra     | `test-utils`                                                         | `destination-postgres`, `openapi`, `hono`, `pg`                         |

**Key rules:**

- Connectors depend on `protocol` and approved shared utilities (`logger`, `openapi`, `util-postgres`) — never on each other or on infrastructure.
- `state-postgres` and `util-postgres` are `pg`-based packages with no connector dependencies. Apps inject them at composition time.
- `apps/service` does NOT depend directly on `pg`; Postgres stores are injected by the CLI/API entrypoints.

## Packages

### `protocol` — core protocol

The shared foundation. Every connector depends on this. Contains message types, interfaces, Zod schemas, and async iterable utilities.

**Package name:** `@stripe/sync-protocol`

**Exports:** `"."` (message types, Source/Destination interfaces, Zod schemas, message helpers), `"./cli"` (CLI argument definitions).

**Dependencies:** `zod` (schema validation), `citty` (CLI argument types), `ix` (async iterable utilities).

### `openapi` — Stripe OpenAPI spec parsing

Fetches and parses Stripe OpenAPI specs. Provides version discovery and type generation utilities.

**Package name:** `@stripe/sync-openapi`

**Exports:** `"."` (main), `"./browser"` (browser-safe subset).

**Dependencies:** `zod`.

### `logger` — structured logging + progress UI

Structured logging via pino with AsyncLocalStorage context propagation. Also provides an ink-based terminal progress UI for the CLI.

**Package name:** `@stripe/sync-logger`

**Exports:** `"."` (main logger), `"./progress"` (ink progress renderer).

**Binary:** `sync-pretty-log` (pino pretty-print transport).

**Dependencies:** `pino`, `ink`, `react`. **Peer:** `@stripe/sync-protocol`.

### `source-stripe` — Stripe API source

Reads from the Stripe REST API via list endpoints (backfill), events API (incremental pull), webhooks (push), and WebSocket (live dev). Uses the raw HTTP client (undici) rather than the Stripe SDK. Includes OpenAPI spec parsing for automatic catalog discovery.

**Package name:** `@stripe/sync-source-stripe`

**Exports:** `"."` (main), `"./browser"` (browser-safe), `"./client"` (HTTP client).

**Binary:** `source-stripe`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-openapi`, `@stripe/sync-logger`, `undici`, `ws`, `zod`.

**Must NOT depend on:** Any destination or infrastructure package.

### `destination-postgres` — Postgres destination

Writes records into a Postgres database. Creates tables from catalog, upserts records with timestamp protection, handles schema projection (column mapping from JSON schema).

**Package name:** `@stripe/sync-destination-postgres`

**Binary:** `destination-postgres`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-util-postgres`, `@stripe/sync-logger`, `pg`, `zod`.

**Optional peers:** `@aws-sdk/client-sts`, `@aws-sdk/rds-signer` (for IAM auth).

**Must NOT depend on:** Any source or infrastructure package.

### `destination-google-sheets` — Google Sheets destination

Writes records into a Google Sheets spreadsheet.

**Package name:** `@stripe/sync-destination-google-sheets`

**Binary:** `destination-google-sheets`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-logger`, `googleapis`, `zod`.

**Must NOT depend on:** Any source or infrastructure package.

### `state-postgres` — Postgres state store

Postgres-specific migration infrastructure. Runs bootstrap and Stripe-specific SQL migrations, handles schema creation, migration tracking, and template rendering.

**Package name:** `@stripe/sync-state-postgres`

**Dependencies:** `@stripe/sync-util-postgres`, `@stripe/sync-logger`, `pg`.

### `util-postgres` — shared Postgres utilities

Shared Postgres helpers used by multiple packages. Batched upsert with timestamp protection, SQL-based token bucket rate limiter.

**Package name:** `@stripe/sync-util-postgres`

**Dependencies:** `@stripe/sync-logger`, `pg`.

### `hono-zod-openapi` — OpenAPI integration for Hono

Bridges Hono's HTTP framework with zod-openapi for automatic OpenAPI spec generation from Zod route schemas.

**Package name:** `@stripe/sync-hono-zod-openapi`

**Dependencies:** `@hono/zod-validator`, `hono`, `zod`, `zod-openapi`.

### `test-utils` — shared test helpers

Test utilities shared across packages: seed data, Postgres fixtures, mock HTTP servers, OpenAPI validation helpers.

**Package name:** `@stripe/sync-test-utils` (private)

**Binary:** `sync-test-utils-server` (test HTTP server).

**Dependencies:** `@hono/node-server`, `@stripe/sync-destination-postgres`, `@stripe/sync-openapi`, `hono`, `pg`.

### `ts-cli` — TypeScript module CLI runner

Generic CLI tool that can call any exported function/method from a TypeScript module, with support for stdin piping, positional args, and named args. Also provides NDJSON streaming and OpenAPI client helpers.

**Package name:** `@stripe/sync-ts-cli` (private)

**Exports:** `"."` (CLI entrypoint), `"./config"`, `"./ndjson"`, `"./openapi"`, `"./env-proxy"`.

**Dependencies:** `citty`.

### `apps/engine` — sync engine library + stateless CLI + HTTP API

The core of the system. Contains the engine that wires source → destination, the connector loader (subprocess adapter + resolution), and pipeline utilities. Also provides the `sync-engine` binary (CLI) and an HTTP API server.

Published as the user-facing npm package.

**Package name:** `@stripe/sync-engine`

**Exports:**

- `"."` — library: `createEngine`, `createConnectorResolver`, `pipe`, `collect`, `filterType`, `enforceCatalog`, `sourceTest`, `destinationTest`, everything from `protocol`
- `"./cli"` — CLI `CommandDef` (citty program, no side effects)
- `"./api"` — `createApp` + `startApiServer` (side-effect-free module surface)
- `"./api/openapi-utils"` — connector schema injection for runtime OAS spec
- `"./progress"` — progress rendering utilities

**Binaries:**

- `sync-engine` → `dist/bin/sync-engine.js`
- `sync-engine-serve` → `dist/bin/serve.js`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-state-postgres`, `@stripe/sync-hono-zod-openapi`, `@stripe/sync-logger`, connectors, `hono`, `openapi-fetch`, `pg`, `ws`.

### `apps/service` — pipeline management service

Manages sync pipelines with credential storage, state persistence, and Temporal workflow orchestration. Provides a REST API for pipeline CRUD, webhook ingress, and sync triggering. Temporal workflows handle long-running syncs with retry, scheduling, and cancellation.

**Package name:** `@stripe/sync-service`

**Exports:** `createSchemas`, `createApp`, `createActivities`, `createWorker`, pipeline types.

**Binary:** `sync-service`

**Dependencies:** `@stripe/sync-engine`, `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `hono`, `openapi-fetch`.

### `apps/dashboard` — web UI

React + Vite single-page application for managing sync pipelines. Consumes the service REST API via `openapi-fetch`. Uses Radix UI + Tailwind for styling.

**Package name:** `@stripe/sync-dashboard` (private)

**Dependencies:** `@radix-ui/*`, `lucide-react`, `openapi-fetch`, `react`, `tailwindcss`.

### `apps/visualizer` — data visualization

Next.js application for exploring and visualizing synced data. Embeds PGlite for client-side SQL and CodeMirror for query editing.

**Package name:** `@stripe/sync-visualizer` (private)

**Dependencies:** `@codemirror/*`, `@electric-sql/pglite`, `@stripe/sync-source-stripe`, `next`, `react`, `tailwindcss`.

### `apps/supabase` — Supabase integration

Deployment target for the Supabase installation flow. Bundles edge functions (Deno runtime) for webhook ingestion, backfill workers, and setup/teardown. Uses `?raw` imports + tsup to bundle edge function code at build time.

**Package name:** `@stripe/sync-integration-supabase`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-source-stripe`, `@stripe/sync-destination-postgres`, `@stripe/sync-state-postgres`, `@stripe/sync-engine`.

## Isolation rules

| Rule                                                                              | Enforced by                      |
| --------------------------------------------------------------------------------- | -------------------------------- |
| `source-*` packages never import from `destination-*` packages                    | CI lint: disallowed import paths |
| `destination-*` packages never import from `source-*` packages                    | CI lint: disallowed import paths |
| `source-*` and `destination-*` only depend on `protocol` + approved shared utils  | package.json audit               |
| `protocol` has zero workspace dependencies                                        | package.json audit               |
| `apps/service` does not depend directly on `pg`                                   | package.json audit               |

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
```

Packages live under `packages/` (reusable libraries) and `apps/` (deployment targets). The workspace enforces consistent tooling (build, test, lint, format) across all packages.
