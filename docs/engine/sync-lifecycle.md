# Sync Lifecycle

How finite sync requests work today: opaque source state, optional
engine-assigned `time_range`, explicit stream lifecycle signals, and
request-level continuation via `eof`. For exact wire types and connector
interfaces, see [protocol.md](./protocol.md).

This phase intentionally keeps the existing terminal `eof` message for backward
compatibility. Treat `eof` as the current alias of a future `end` message. The
explicit client/engine `start` / `end` envelope is deferred to
[`docs/plans/2026-04-17-start-end-envelope-migration.md`](../plans/2026-04-17-start-end-envelope-migration.md).

## Scope

This design is intentionally narrow:

- Incremental backfills only.
- Finite reads only.
- `full_refresh` is out of scope.
- Live `/events` polling is out of scope.
- Generic stall detection is out of scope.
- Client/engine envelope renames are out of scope for this phase.

## Removed From This Phase

To keep lifecycle semantics tight, this phase explicitly removes these ideas:

- **No `full_refresh` lifecycle.** `sync_mode: 'full_refresh'` and
  `destination_sync_mode: 'overwrite'` need separate semantics because "done for
  this request sequence" and "historical coverage" mean different things for a
  full reread.
- **No `range_complete`-driven terminality.** `range_complete` remains optional
  progress telemetry only. It does not drive `has_more`.
- **No cross-request range subdivision in the generic protocol.** The generic
  lifecycle does not assume that a partially paginated time range can be split
  into smaller ranges between requests.
- **No `start` / `end` envelope migration in this phase.** Existing request
  entrypoints stay as-is. The terminal message remains `eof`.

## Motivation

The base protocol treats each request as independent. The caller manages
pagination, upper bounds, and continuation externally. That creates three
problems:

1. **Backfill bounds shift between requests.** A stream that derives its own
   upper bound from `now()` can chase a moving target forever.
2. **Completion is ambiguous.** If the engine inspects source-specific state to
   guess whether a stream is done, protocol behavior depends on connector
   internals instead of explicit source signals.
3. **`eof.reason` is not enough on its own.** It explains why the request
   stopped, but it does not tell the caller whether it should continue.

This phase keeps the request shape stable and adds `has_more` to `eof` so
callers can continue without interpreting opaque source state.

---

## Layers

```
CLIENT  ←—existing sync API + eof—→  ENGINE  ←—iterator—→  SOURCE
```

| Concern             | Client                            | Engine                                               | Source                                                 |
| ------------------- | --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| What to sync        | Provides catalog                  | Passes catalog through, may inject `time_range`      | Syncs what it's given                                  |
| When to sync        | Decides                           | —                                                    | —                                                      |
| Time range bounds   | —                                 | May inject `time_range`, may preserve bound metadata | Respects `time_range` if present                       |
| Internal pagination | —                                 | —                                                    | Manages `starting_after` / equivalent                  |
| Stream lifecycle    | Consumes                          | Tracks terminal streams                              | Emits `started`, optional `range_complete`, `complete` |
| Progress reporting  | Consumes                          | Emits request-level snapshots and terminal state     | Emits records, checkpoints, traces                     |
| Error reporting     | Decides retry policy above engine | Passes through / aggregates                          | Classifies and emits trace errors                      |
| State               | Opaque round-trip                 | Manages engine section                               | Manages source section                                 |
| `has_more`          | Reads, acts                       | Derives from explicit terminal stream state          | —                                                      |
| Terminal message    | Receives `eof`                    | Emits `eof` with `reason` + `has_more`               | —                                                      |

---

## Core Rule

The engine trusts only explicit stream status messages for lifecycle:

- `started` means the stream is active for this request.
- `range_complete` is progress telemetry only.
- `complete` is the only terminal signal.
- There is no `running` status.

The engine does **not** inspect source state to infer completion. Source state is
opaque cursor data.

---

## Request + Terminal Message

### Client → engine

The client/engine request envelope stays unchanged in this phase. A later plan
can introduce an explicit `start` message and any run-identity cleanup after
the `eof.has_more` flow is stable.

### `eof` — engine → client

Every request ends with `eof`. This phase keeps `eof.reason` and adds
`has_more`.

`has_more: true` means at least one configured stream has not yet emitted
`stream_status: complete` for this request sequence. Continue by calling the
same sync entrypoint again with the returned `eof.state`.

`has_more: false` means every configured stream is terminal. The next sync
should begin from a fresh caller-controlled starting point.

```ts
{
  type: 'eof',
  eof: {
    reason: 'time_limit',
    has_more: true,
    state: SyncState,
  },
}
```

`eof` may also carry the terminal progress snapshot for the request. The exact
wire shape continues to live in `protocol.ts`.

### Source → engine

Sources remain iterators that emit `record`, `source_state`, `trace`, and `log`
messages. This phase does not introduce new top-level `progress` or `end`
message kinds.

---

## Stream Status

`stream_status` remains a discriminated union on `status`:

```ts
type StreamStatus =
  | { stream: string; status: 'started' }
  | { stream: string; status: 'range_complete'; range_complete: { gte: string; lt: string } }
  | { stream: string; status: 'complete' }
```

| Status           | Meaning                         | Engine action                   |
| ---------------- | ------------------------------- | ------------------------------- |
| `started`        | Stream is active                | Mark stream active for progress |
| `range_complete` | A time range finished           | Update progress only            |
| `complete`       | Stream is terminal for this run | Mark stream terminal            |

`range_complete` is only meaningful for streams that support engine-assigned
`time_range`. It is not used to derive `has_more`.

A source that decides to stop a stream after a stream-level error should still
emit `complete` for that stream. That keeps lifecycle semantics explicit:
errors explain _why_ the stream stopped; `complete` says it is terminal.

---

## State and Continuation

`SyncState` is still round-tripped opaquely by the caller:

- The **source section** stores cursor data the engine does not interpret.
- The **engine section** may store terminal streams, `completed_ranges`,
  progress snapshots, and any bound metadata needed to continue safely.

Callers continue by round-tripping `eof.state`. This phase does **not** require
an explicit `sync_run_id`; if we add one later, that belongs to the follow-up
`start` / `end` envelope plan.

---

## Time Ranges

Time range support is optional per stream.

### Streams with `supports_time_range: true`

- The engine may inject `time_range`.
- The engine may preserve any needed upper-bound metadata in engine-owned state.
- The source resumes within that range using opaque source state.
- The source may emit `range_complete` for progress reporting.

### Streams with `supports_time_range: false`

- The engine does not inject `time_range`.
- The source paginates using its own cursor semantics only.
- No coverage accounting is implied.

### Why this matters

- Stable upper bounds prevent moving-target backfills for eligible streams.
- Streams without time filtering still fit the same continuation contract.
- The engine never needs to understand source-specific pagination tokens.

---

## `has_more` Derivation

The engine derives `has_more` from explicit terminal stream state:

```ts
has_more = configured_catalog.streams.some(
  (stream) => !engine.terminal_streams.includes(stream.name)
)
```

`completed_ranges`, source-state shape, and transient errors do not participate
in this decision.

---

## Errors

Lifecycle and errors remain orthogonal:

- `eof.reason` explains why the request stopped (`complete`, `state_limit`,
  `time_limit`, `error`, `aborted`).
- `has_more` explains whether the caller should continue.
- Stream-level errors do not replace explicit `complete`.
- `range_complete` never implies terminality.

---

## Future Follow-Up

Explicit `start` input, explicit `end` output, `sync_run_id`, and any eventual
rename of `eof` are intentionally split into a later plan:
[`docs/plans/2026-04-17-start-end-envelope-migration.md`](../plans/2026-04-17-start-end-envelope-migration.md).
