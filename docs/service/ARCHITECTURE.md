# Stripe Sync

Stripe Sync lets merchants create **sync pipelines** that continuously move data from a source system into a destination.

## System layers

```
Service (pipeline management + Temporal workflows + webhook ingress)
  └── Engine (wires source → destination, persists state)
        ├── Source (reads upstream data)
        └── Destination (writes downstream data)
```

- **Service** — the stateful layer. Manages pipelines (CRUD), credentials, state persistence, and orchestrates long-running syncs via Temporal workflows. Exposed via `apps/service` (REST API + CLI).

- **Engine** — the runtime that pipes a source to a destination. Filters messages (only data messages reach the destination), persists committed state checkpoints, handles errors, and routes logs. See [`../engine/ARCHITECTURE.md`](../engine/ARCHITECTURE.md).

- **Source / Destination** — the actual implementations that read from or write to external systems. Defined by the sync engine protocol in `packages/protocol`.

## Core Model

A **Pipeline** connects a **source** to a **destination**. Both may reference a **credential** for authentication. Pipelines are the unit of management — they can be created, synced, checked, set up, and torn down.

- **SourceConfig** — where data comes from (e.g. Stripe API)
- **DestinationConfig** — where data lands (e.g. Postgres, Google Sheets)
- **Credential** — stored connection secrets (API keys, database passwords, OAuth tokens)
- **PipelineStatus** — lifecycle state tracking for the pipeline

## Why "source" and not just "Stripe"?

The source isn't always Stripe. Other data providers may have their own source implementations. Keeping source as a first-class concept means the same pipeline model works for all of them.

## Source credentials

A Stripe organization may want to sync from a specific Stripe account. The source needs a credential (API key) to authenticate. Third-party sources will always need a user-supplied credential.

## Temporal workflows

Long-running sync operations are orchestrated via Temporal. This provides:

- **Durable execution** — syncs survive process restarts
- **Retry with backoff** — transient failures are retried automatically
- **Cancellation** — running syncs can be cleanly stopped
- **Scheduling** — periodic syncs via Temporal schedules

## Files

| File                                | Description                                                    |
| ----------------------------------- | -------------------------------------------------------------- |
| `packages/protocol/src/protocol.ts` | TypeScript interfaces for Source, Destination; message types   |
| `apps/engine/src/lib/engine.ts`     | `createEngine()` — engine factory                              |
| `apps/service/src/lib/stores.ts`    | Store interfaces: CredentialStore, StateStore, LogSink         |
| `apps/service/src/api/app.ts`       | Service HTTP API (pipeline CRUD, webhook ingress, sync trigger)|
| `apps/service/src/cli/index.ts`     | Service CLI entrypoint                                         |
| `apps/service/src/temporal/`        | Temporal workflows, activities, and worker                     |
