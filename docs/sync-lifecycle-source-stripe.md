# Sync Lifecycle — Stripe Source

How the Stripe source manages pagination within a `time_range` assigned by the
engine. For the overall sync lifecycle and protocol, see
[engine/sync-lifecycle.md](./engine/sync-lifecycle.md).

## Overview

The engine assigns a `time_range` per stream via the configured catalog. The
Stripe source's job is to paginate all records within that range and emit them.
It manages its own sub-range splitting and parallelism internally.

## Source State

```ts
type StripeStreamState = {
  ranges: Array<{
    gte: string            // ISO 8601 — inclusive lower bound
    lt: string             // ISO 8601 — exclusive upper bound
    cursor: string | null  // Stripe pagination cursor; null = not yet started
  }>
}
```

- A range with `cursor: null` → source has planned this range but not yet fetched the first page.
- A range with `cursor: "cus_abc"` → resume pagination after this object.
- A range removed from the list → that sub-range is complete.
- Empty `ranges: []` → source is done with the assigned `time_range`.

## Workflow

### 1. Initialization (no existing state)

The source receives `time_range` from the catalog and has no state for this
stream.

1. Probe density: make one request to the Stripe list API with the full range
   to estimate how many records exist.
2. Based on density, split the `time_range` into N sub-ranges (using the
   `created` timestamp filter). Denser ranges get more sub-ranges.
3. Initialize state with all sub-ranges, `cursor: null`.

```
Engine assigns: time_range { gte: "2018-01-01", lt: "2024-04-17" }

Source probes density → estimates 200K records → splits into 8 sub-ranges:

state: {
  ranges: [
    { gte: "2018-01-01", lt: "2018-10-01", cursor: null },
    { gte: "2018-10-01", lt: "2019-07-01", cursor: null },
    { gte: "2019-07-01", lt: "2020-04-01", cursor: null },
    { gte: "2020-04-01", lt: "2021-01-01", cursor: null },
    { gte: "2021-01-01", lt: "2021-10-01", cursor: null },
    { gte: "2021-10-01", lt: "2022-07-01", cursor: null },
    { gte: "2022-07-01", lt: "2023-04-01", cursor: null },
    { gte: "2023-04-01", lt: "2024-04-17", cursor: null }
  ]
}
```

### 2. Pagination

The source paginates sub-ranges, potentially in parallel. For each sub-range:

1. Call the Stripe list API with `created[gte]` and `created[lt]` filters,
   plus `starting_after` if resuming from a cursor.
2. Emit records.
3. Emit `source_state` with updated cursor after each page.
4. When a sub-range is exhausted (`has_more: false`), remove it from state.

```
After paginating first sub-range (2 pages):

state: {
  ranges: [
    { gte: "2018-01-01", lt: "2018-10-01", cursor: "cus_abc" },  // mid-page
    { gte: "2018-10-01", lt: "2019-07-01", cursor: null },
    ...
  ]
}
→ emit source_state with time_range: { gte: "2018-01-01", lt: "2024-04-17" }

First sub-range exhausted:

state: {
  ranges: [
    { gte: "2018-10-01", lt: "2019-07-01", cursor: "cus_def" },  // now active
    { gte: "2019-07-01", lt: "2020-04-01", cursor: null },
    ...
  ]
}
→ emit source_state
```

### 3. Resumption (existing state)

If the source has existing state for this stream (from a previous request in
the same sync run), it skips initialization and resumes directly from the
remaining ranges:

```
Source receives time_range { gte: "2018-01-01", lt: "2024-04-17" }
Existing state: {
  ranges: [
    { gte: "2021-10-01", lt: "2022-07-01", cursor: "cus_xyz" },
    { gte: "2022-07-01", lt: "2023-04-01", cursor: null },
    { gte: "2023-04-01", lt: "2024-04-17", cursor: null }
  ]
}

→ Resume paginating from cus_xyz in [2021-10, 2022-07)
→ No density probing, no re-splitting
```

### 4. Subdivision

If a sub-range is too dense (too many records, taking too long), the source
can subdivide it further:

```
Before — one large range taking too long:
  { gte: "2021-01-01", lt: "2022-07-01", cursor: null }

After subdivision — split in half:
  { gte: "2021-01-01", lt: "2021-10-01", cursor: null }
  { gte: "2021-10-01", lt: "2022-07-01", cursor: null }
```

This is the binary search behavior: ranges that don't complete in time get
split. The source decides when and how to subdivide based on observed
pagination speed.

A sub-range that already has a cursor (mid-pagination) is NOT subdivided —
it's making progress. Only ranges with `cursor: null` that haven't started
or ranges that are progressing too slowly are candidates.

### 5. Completion

When all sub-ranges are exhausted:

```
state: { ranges: [] }
→ emit source_state with time_range
```

The engine observes empty ranges and marks this `time_range` as complete
in `completed_ranges`.

## State on the Wire

The source emits `source_state` messages with the `time_range` from the
catalog so the engine can track which range this state belongs to:

```ts
{
  type: 'source_state',
  source_state: {
    state_type: 'stream',
    stream: 'customers',
    time_range: { gte: '2018-01-01T00:00:00Z', lt: '2024-04-17T00:00:00Z' },
    data: {
      ranges: [
        { gte: '2021-10-01T00:00:00Z', lt: '2022-07-01T00:00:00Z', cursor: 'cus_xyz' },
        { gte: '2022-07-01T00:00:00Z', lt: '2023-04-01T00:00:00Z', cursor: null },
        { gte: '2023-04-01T00:00:00Z', lt: '2024-04-17T00:00:00Z', cursor: null }
      ]
    }
  }
}
```

## Parallel Pagination

The source can paginate multiple sub-ranges concurrently. The number of
concurrent sub-ranges is determined by the density probe and available
concurrency budget. Records from different sub-ranges are interleaved
on the output stream, each tagged with the stream name.

State checkpoints are emitted after each page completes, reflecting the
current state of all sub-ranges. This ensures resumability even if the
source is cut off mid-run.

## Error Handling

- **Transient errors** (rate limits, 5xx, timeouts): Retried at the HTTP
  layer with exponential backoff. If retries succeed, emit a `transient`
  error trace for observability.
- **Stream errors** (resource not available, permission denied): Emit a
  `stream` error trace, stop this stream, move to the next.
- **Global errors** (invalid API key): Emit a `global` error trace, stop.

The source does not store error state. If a sub-range fails after all
retries, the source emits an error trace and moves on. The sub-range
remains in state (with its cursor) for the next attempt.

## Events / Incremental Sync

After backfill completes, the source switches to incremental mode using
Stripe's `/events` API or WebSocket. This is outside the `time_range`
model — events are a live stream, not a bounded range.

The global state stores an `events_cursor` for resumption:

```ts
// source.global
{ events_cursor: "2024-04-16T23:50:00Z" }
```

Events and backfill can run concurrently — backfill covers historical data
within `time_range`, events cover real-time changes.
