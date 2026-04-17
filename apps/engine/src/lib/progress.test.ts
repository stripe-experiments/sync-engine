import { describe, expect, it } from 'vitest'
import type { Message, SyncOutput } from '@stripe/sync-protocol'
import { createRecordCounter, mergeRanges, trackProgress } from './progress.js'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('createRecordCounter', () => {
  it('counts records by stream on the data path', async () => {
    const counter = createRecordCounter()
    const records: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
      },
    ]

    const drained = await collect(counter.tap(toAsync(records)))
    expect(drained).toHaveLength(3)
    expect(counter.counts.get('customers')).toBe(2)
  })
})

describe('trackProgress', () => {
  it('emits enriched EOF with global and stream progress', async () => {
    const counter = createRecordCounter()
    await collect(
      counter.tap(
        toAsync<Message>([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_2' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
        ])
      )
    )

    const outputs = await collect(
      trackProgress({
        initial_state: {
          source: { streams: {}, global: {} },
          destination: { streams: {}, global: {} },
          engine: {
            streams: { customers: { cumulative_record_count: 5 } },
            global: {},
          },
        },
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: { stream: 'customers', status: 'complete' },
            },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'error',
              error: { message: 'boom', failure_type: 'system_error', stream: 'customers' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const globalProgressTraces = outputs.filter(
      (m) => m.type === 'trace' && m.trace.trace_type === 'global_progress'
    )
    expect(globalProgressTraces.length).toBeGreaterThan(0)

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toBeDefined()
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        reason: 'complete',
        state: {
          source: {
            streams: { customers: { cursor: '2' } },
            global: {},
          },
          destination: { streams: {}, global: {} },
          engine: {
            streams: { customers: { cumulative_record_count: 7, status: 'complete' } },
            global: {},
          },
        },
        global_progress: {
          run_record_count: 2,
          state_checkpoint_count: 1,
        },
        stream_progress: {
          customers: {
            status: 'complete',
            cumulative_record_count: 7,
            run_record_count: 2,
            errors: [{ message: 'boom', failure_type: 'system_error' }],
          },
        },
      },
    })
  })

  it('emits stream_status only on transitions, not periodically', async () => {
    const counter = createRecordCounter()
    const outputs = await collect(
      trackProgress({
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
          },
          // Second source_state for same stream should NOT emit another stream_status
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: { stream: 'customers', status: 'complete' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const streamStatusTraces = outputs.filter(
      (m) =>
        m.type === 'trace' && m.trace.trace_type === 'stream_status' && m._emitted_by === 'engine'
    )
    // First source_state → started transition + complete transition + final on EOF = 3
    // The second source_state should NOT trigger another (already started)
    const statusValues = streamStatusTraces.map((m) => (m as any).trace.stream_status.status)
    // started (from first source_state), complete (from stream_status trace), complete (final on EOF)
    expect(statusValues).toEqual(['started', 'complete', 'complete'])
  })

  it('co-emits global_progress with every stream_status', async () => {
    const counter = createRecordCounter()
    const outputs = await collect(
      trackProgress({
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    // Every stream_status from engine should be followed by a global_progress
    const engineTraces = outputs.filter((m) => m.type === 'trace' && m._emitted_by === 'engine')
    for (let i = 0; i < engineTraces.length - 1; i++) {
      const current = engineTraces[i] as any
      const next = engineTraces[i + 1] as any
      if (current.trace.trace_type === 'stream_status') {
        expect(next.trace.trace_type).toBe('global_progress')
      }
    }
  })

  it('emits catalog as first message when provided', async () => {
    const counter = createRecordCounter()
    const outputs = await collect(
      trackProgress({
        recordCounter: counter,
        catalog: {
          streams: [
            {
              stream: { name: 'customers', primary_key: [['id']] },
              sync_mode: 'incremental',
              destination_sync_mode: 'append',
            },
          ],
        },
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'complete' } }]))
    )

    expect(outputs[0]).toMatchObject({
      type: 'catalog',
      catalog: { streams: [{ name: 'customers', primary_key: [['id']] }] },
    })
  })

  it('errors are orthogonal to lifecycle status', async () => {
    const counter = createRecordCounter()
    const outputs = await collect(
      trackProgress({
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'error',
              error: {
                message: 'rate limited',
                failure_type: 'transient_error',
                stream: 'customers',
              },
            },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: { stream: 'customers', status: 'complete' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof') as any
    // Stream is complete AND has errors — they're orthogonal
    expect(eof.eof.stream_progress.customers.status).toBe('complete')
    expect(eof.eof.stream_progress.customers.errors).toEqual([
      { message: 'rate limited', failure_type: 'transient_error' },
    ])
  })

  it('aggregates multiple stream states and global state into EOF', async () => {
    const counter = createRecordCounter()
    await collect(
      counter.tap(
        toAsync<Message>([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
          {
            type: 'record',
            record: {
              stream: 'invoices',
              data: { id: 'inv_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
        ])
      )
    )

    const outputs = await collect(
      trackProgress({
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
          },
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'invoices', data: { cursor: 'a' } },
          },
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '3' } },
          },
          {
            type: 'source_state',
            source_state: {
              state_type: 'global',
              data: { events_cursor: 'evt_123' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toBeDefined()
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        reason: 'complete',
        state: {
          source: {
            streams: {
              customers: { cursor: '3' },
              invoices: { cursor: 'a' },
            },
            global: { events_cursor: 'evt_123' },
          },
          destination: { streams: {}, global: {} },
          engine: {
            streams: {
              customers: { cumulative_record_count: 1, status: 'started' },
              invoices: { cumulative_record_count: 1, status: 'started' },
            },
            global: {},
          },
        },
      },
    })
  })

  it('merges eof state into the provided initial sync state', async () => {
    const counter = createRecordCounter()
    await collect(
      counter.tap(
        toAsync<Message>([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
        ])
      )
    )

    const outputs = await collect(
      trackProgress({
        initial_state: {
          source: {
            streams: {
              customers: { cursor: 'cus_0' },
              invoices: { cursor: 'inv_2' },
            },
            global: { events_cursor: 'evt_old' },
          },
          destination: {
            streams: { customers: { watermark: 10 } },
            global: { schema_version: 1 },
          },
          engine: {
            streams: {
              customers: { cumulative_record_count: 5, note: 'keep-me' },
              invoices: { cumulative_record_count: 2, untouched: true },
            },
            global: { sync_id: 'prev' },
          },
        },
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'cus_1' } },
          },
          {
            type: 'source_state',
            source_state: { state_type: 'global', data: { events_cursor: 'evt_new' } },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          source: {
            streams: {
              customers: { cursor: 'cus_1' },
              invoices: { cursor: 'inv_2' },
            },
            global: { events_cursor: 'evt_new' },
          },
          destination: {
            streams: { customers: { watermark: 10 } },
            global: { schema_version: 1 },
          },
          engine: {
            streams: {
              customers: { cumulative_record_count: 6, note: 'keep-me', status: 'started' },
              invoices: { cumulative_record_count: 2, untouched: true },
            },
          },
        },
      },
    })
  })

  it('returns the initial sync state on a no-op resumed run', async () => {
    const initialState = {
      source: {
        streams: { customers: { cursor: 'cus_9' } },
        global: { events_cursor: 'evt_9' },
      },
      destination: {
        streams: { customers: { watermark: 99 } },
        global: { schema_version: 2 },
      },
      engine: {
        streams: { customers: { cumulative_record_count: 9 } },
        global: { sync_id: 'resume-9' },
      },
    }

    const outputs = await collect(
      trackProgress({
        initial_state: initialState,
        recordCounter: createRecordCounter(),
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'complete' } }]))
    )

    const eof = outputs.find((m) => m.type === 'eof')
    // Engine global is enriched with cumulative totals, so partial match
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          source: initialState.source,
          destination: initialState.destination,
          engine: {
            streams: initialState.engine.streams,
          },
        },
      },
    })
  })

  it('includes engine global cumulative stats even when no source_state messages were emitted', async () => {
    const counter = createRecordCounter()
    const outputs = await collect(
      trackProgress({
        recordCounter: counter,
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'complete' } }]))
    )

    const eof = outputs.find((m) => m.type === 'eof') as any
    expect(eof).toBeDefined()
    // Engine global always has cumulative stats (zeroed out for fresh runs)
    expect(eof.eof.state.engine.global).toMatchObject({
      cumulative_record_count: 0,
      cumulative_request_count: 0,
    })
    // No source or destination state since no messages were emitted
    expect(Object.keys(eof.eof.state.source.streams)).toHaveLength(0)
  })

  it('accumulates range_complete into completed_ranges in engine state', async () => {
    const outputs = await collect(
      trackProgress({

        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: { stream: 'customers', status: 'started' },
            },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: {
                stream: 'customers',
                status: 'started',
                range_complete: { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
              },
            },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: {
                stream: 'customers',
                status: 'started',
                range_complete: { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
              },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          engine: {
            streams: {
              customers: {
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' }],
              },
            },
          },
        },
      },
    })
  })

  it('range_complete does not overwrite stream status', async () => {
    const outputs = await collect(
      trackProgress({
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: { stream: 'customers', status: 'started' },
            },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: {
                stream: 'customers',
                status: 'started',
                range_complete: { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
              },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        stream_progress: {
          customers: { status: 'complete' },
        },
      },
    })
  })

  it('seeds completed_ranges from initial engine state', async () => {
    const outputs = await collect(
      trackProgress({

        initial_state: {
          source: { streams: {}, global: {} },
          destination: { streams: {}, global: {} },
          engine: {
            streams: {
              customers: {
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
              },
            },
            global: {},
          },
        },
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: {
                stream: 'customers',
                status: 'started',
                range_complete: { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
              },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          engine: {
            streams: {
              customers: {
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' }],
              },
            },
          },
        },
      },
    })
  })
})

describe('mergeRanges', () => {
  it('returns empty for empty input', () => {
    expect(mergeRanges([])).toEqual([])
  })

  it('returns single range unchanged', () => {
    const ranges = [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('merges adjacent ranges', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('merges overlapping ranges', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-07-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('keeps non-overlapping ranges separate', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-03-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('sorts and merges out-of-order ranges', () => {
    const ranges = [
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('merges multiple overlapping ranges into one', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-04-01T00:00:00Z' },
      { gte: '2024-03-01T00:00:00Z', lt: '2024-07-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('does not mutate input array', () => {
    const ranges = [
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
    ]
    const original = JSON.parse(JSON.stringify(ranges))
    mergeRanges(ranges)
    expect(ranges).toEqual(original)
  })
})
