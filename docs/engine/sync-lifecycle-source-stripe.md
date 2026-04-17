# Sync Lifecycle — Stripe Source

How the Stripe source paginates finite backfills within the lifecycle described
in [sync-lifecycle.md](./sync-lifecycle.md).

## Overview

Stripe list pagination is resumable because the API accepts an object-ID cursor:

```http
GET /v1/customers?limit=100&starting_after=cus_123
```

For the same endpoint and same filter set, `starting_after` means "continue
after this object in the current list order."

Stripe list endpoints return objects in descending `created` order. That makes
`starting_after` sufficient for continuation across requests:

- The source stores the last emitted object ID as `starting_after`.
- On the next request, it replays the same query shape and resumes from that ID.
- For streams that support `created` filtering, the engine can also assign a
  fixed `time_range`.

This design does **not** split partially paginated ranges across requests. A
time-range stream resumes the same assigned range until it emits `complete`.

## Two Stream Modes

### Time-range streams

These streams support Stripe `created[gte]` / `created[lt]` filters.

- The engine injects `time_range`.
- The source paginates with `created[...]` plus `starting_after`.
- The source may emit `range_complete` when the assigned range is fully read.
- The source emits `complete` when the stream is terminal for the run.

### Non-time-range streams

These streams do not support `created` filtering.

- The engine does not inject `time_range`.
- The source paginates with `starting_after` only.
- There is no range coverage accounting.
- The source emits `complete` when the stream is terminal for the run.

Not every Stripe endpoint supports every pagination feature. Streams only enter
the time-range path if the endpoint supports the necessary `created` filters.

## Source State

Stripe source state is opaque to the engine. The minimal per-stream form is:

```ts
type StripeStreamState = {
  starting_after: string | null
}
```

- `starting_after: null` means "start from the first page".
- `starting_after: "cus_abc"` means "resume after object `cus_abc`".

The assigned `time_range`, when present, lives in the configured catalog. It is
not inferred from source state.

## Pagination Algorithm

### 1. Initialization

If there is no saved state:

- For a time-range stream, the source receives `time_range` from the engine and
  starts with `starting_after: null`.
- For a non-time-range stream, the source starts with `starting_after: null`.

### 2. Page fetch

For each page:

1. Build request params.
2. Call the Stripe list endpoint.
3. Emit records in the order returned by Stripe.
4. Save the last emitted object ID as `starting_after`.
5. Emit `source_state`.

Time-range example:

```http
GET /v1/customers?limit=100&created[gte]=1514764800&created[lt]=1713312000
GET /v1/customers?limit=100&created[gte]=1514764800&created[lt]=1713312000&starting_after=cus_100
```

Non-time-range example:

```http
GET /v1/reporting/report_types?limit=100
GET /v1/reporting/report_types?limit=100&starting_after=rpt_100
```

### 3. Resumption

On the next request in the same sync run:

- The engine reuses the same `sync_run_id`.
- For time-range streams, the engine re-injects the same fixed `time_range`.
- The source loads `starting_after` from source state.
- The source resumes the exact same query shape with that `starting_after`.

This works because `starting_after` is an object ID in Stripe's stable list
ordering. It is a resume token for pagination, not a derived time boundary.

### 4. Completion

When Stripe returns `has_more: false` for the current stream:

1. The source emits a final `source_state`.
2. If the stream had an assigned `time_range`, the source may emit
   `stream_status: range_complete` for that range.
3. The source emits `stream_status: complete`.

`complete` is the terminal signal the engine trusts. `range_complete` is
progress telemetry only.

## Message Examples

### Time-range stream

Request 1:

```text
Engine assigns: customers time_range [2018-01-01, 2024-04-17)

← trace   { stream_status: { stream: "customers", status: "started" } }
← record  { stream: "customers", data: { id: "cus_001", ... } }
← state   { stream: "customers", data: { starting_after: "cus_100" } }
← record  { stream: "customers", data: { id: "cus_101", ... } }
← state   { stream: "customers", data: { starting_after: "cus_200" } }
... cut off ...
← end     { has_more: true }
```

Request 2:

```text
Engine reassigns the same customers time_range [2018-01-01, 2024-04-17)
Source resumes with starting_after = "cus_200"

← record  { stream: "customers", data: { id: "cus_201", ... } }
← state   { stream: "customers", data: { starting_after: "cus_300" } }
... final page ...
← state   { stream: "customers", data: { starting_after: "cus_5421" } }
← trace   { stream_status: { stream: "customers", status: "range_complete",
              range_complete: { gte: "2018-01-01T00:00:00Z", lt: "2024-04-17T00:00:00Z" } } }
← trace   { stream_status: { stream: "customers", status: "complete" } }
← end     { has_more: false }
```

### Non-time-range stream

```text
No time_range assigned

← trace   { stream_status: { stream: "reporting_report_types", status: "started" } }
← record  { stream: "reporting_report_types", data: { id: "rpt_001", ... } }
← state   { stream: "reporting_report_types", data: { starting_after: "rpt_001" } }
... final page ...
← trace   { stream_status: { stream: "reporting_report_types", status: "complete" } }
```

## State on the Wire

```ts
{
  type: 'source_state',
  source_state: {
    state_type: 'stream',
    stream: 'customers',
    data: {
      starting_after: 'cus_200'
    }
  }
}
```

The engine persists this state opaquely and passes it back on continuation. It
does not inspect `starting_after`.

## Error Handling

- **Transient errors**: retry at the HTTP layer and emit a `transient` error
  trace for observability.
- **Stream errors**: emit a `stream` error trace, stop this stream, then emit
  `complete` for explicit terminality.
- **Global errors**: emit a `global` error trace and stop the sync.

The source does not encode error semantics into source state.

## Exclusions

This lifecycle doc does not cover:

- live `/events` polling
- cross-request range subdivision
- `ending_before`-driven reverse scans
- `full_refresh` semantics

In protocol terms, Stripe backfill now explicitly removes:

- using `starting_after` to derive new time boundaries between requests
- requiring every stream to support `time_range`
- using `range_complete` to decide terminality
