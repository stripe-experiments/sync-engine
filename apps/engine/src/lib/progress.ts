import type {
  Message,
  SyncState,
  SyncOutput,
  TraceStreamStatus,
  TraceError,
  TraceGlobalProgress,
  EofPayload,
  EofStreamProgress,
  ConfiguredCatalog,
} from '@stripe/sync-protocol'
import { emptySyncState } from '@stripe/sync-protocol'

type Range = { gte: string; lt: string }

/**
 * Merge overlapping or adjacent ISO 8601 ranges into a minimal sorted set.
 * Assumes ranges use string-comparable timestamps (ISO 8601).
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice()
  const sorted = ranges.slice().sort((a, b) => (a.gte < b.gte ? -1 : a.gte > b.gte ? 1 : 0))
  const merged: Range[] = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!
    const last = merged[merged.length - 1]!
    if (cur.gte <= last.lt) {
      last.lt = cur.lt > last.lt ? cur.lt : last.lt
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

type StreamError = { message: string; failure_type?: TraceError['failure_type'] }
type Status = TraceStreamStatus['status']

/**
 * Shared record counter that can be tapped into the data pipeline (before the
 * destination) to count records. The trackProgress() stage reads from it.
 */
export function createRecordCounter() {
  const counts = new Map<string, number>()
  return {
    counts,
    tap<T extends Message>(msgs: AsyncIterable<T>): AsyncIterable<T> {
      const self = this
      return (async function* () {
        for await (const msg of msgs) {
          if (msg.type === 'record' && 'record' in msg) {
            const stream = (msg as { record: { stream: string } }).record.stream
            self.counts.set(stream, (self.counts.get(stream) ?? 0) + 1)
          }
          yield msg
        }
      })()
    },
  }
}

export function trackProgress(opts: {
  initial_state?: SyncState
  /** Configured catalog — emitted as the first message so the UI knows all streams upfront. */
  catalog?: ConfiguredCatalog
  /** Shared counter fed by createRecordCounter().tap() on the data path. */
  recordCounter?: ReturnType<typeof createRecordCounter>
}): (msgs: AsyncIterable<SyncOutput>) => AsyncIterable<SyncOutput> {
  return async function* (messages) {
    // Initialize cumulative counts from engine state
    const initialCumulativeCounts = opts.initial_state?.engine?.streams
      ? Object.fromEntries(
          Object.entries(opts.initial_state.engine.streams)
            .map(([k, v]) => [
              k,
              (v as { cumulative_record_count?: number })?.cumulative_record_count ?? 0,
            ])
            .filter(([, v]) => typeof v === 'number' && v >= 0)
        )
      : {}
    const cumulativeRecordCount = new Map<string, number>(Object.entries(initialCumulativeCounts))

    // Initialize cumulative global stats from engine state
    const engineGlobal = (opts.initial_state?.engine?.global ?? {}) as Record<string, unknown>
    let cumulativeGlobalRecordCount = (engineGlobal.cumulative_record_count as number) ?? 0
    let cumulativeRequestCount = (engineGlobal.cumulative_request_count as number) ?? 0
    let cumulativeElapsedMs = (engineGlobal.cumulative_elapsed_ms as number) ?? 0

    let stateCheckpointCount = 0
    const streamStatus = new Map<string, Status>()
    const completedRanges = new Map<string, Range[]>()
    const lastEmittedStatus = new Map<string, Status>()

    // Restore stream statuses and completed_ranges from engine state
    if (opts.initial_state?.engine?.streams) {
      for (const [stream, data] of Object.entries(opts.initial_state.engine.streams)) {
        const d = data as { status?: Status; completed_ranges?: Range[] }
        if (d?.status === 'started' || d?.status === 'complete') {
          streamStatus.set(stream, d.status)
        }
        if (d?.completed_ranges && Array.isArray(d.completed_ranges)) {
          completedRanges.set(stream, d.completed_ranges.slice())
        }
      }
    }
    if (opts.initial_state?.source?.streams) {
      for (const [stream, data] of Object.entries(opts.initial_state.source.streams)) {
        const srcStatus = (data as { status?: string })?.status
        // Map source error statuses to lifecycle status for the engine
        if (srcStatus === 'complete') {
          streamStatus.set(stream, 'complete')
        } else if (
          srcStatus === 'pending' ||
          srcStatus === 'transient_error' ||
          srcStatus === 'system_error' ||
          srcStatus === 'config_error' ||
          srcStatus === 'auth_error'
        ) {
          // Source hasn't completed — keep as started (or don't set if not started yet)
          if (streamStatus.has(stream)) {
            // Already has a status from engine state, keep it unless it was complete
            // and source says otherwise
          } else if (srcStatus !== 'pending') {
            streamStatus.set(stream, 'started')
          }
        }
      }
    }

    const streamErrors = new Map<string, StreamError[]>()
    const hadInitialState = opts.initial_state != null
    const finalState: SyncState = structuredClone(opts.initial_state ?? emptySyncState())

    const startedAt = Date.now()
    let lastWindowAt = startedAt
    let prevWindowTotal = 0

    function elapsedMs() {
      return Date.now() - startedAt
    }

    function elapsedSec() {
      return Math.max(elapsedMs() / 1000, 0.001)
    }

    function runRecordCount(stream: string): number {
      return opts.recordCounter?.counts.get(stream) ?? 0
    }

    function totalRunRecords(): number {
      if (!opts.recordCounter) return 0
      let sum = 0
      for (const v of opts.recordCounter.counts.values()) sum += v
      return sum
    }

    function totalWindowRecords(): number {
      return totalRunRecords() - prevWindowTotal
    }

    function allStreams(): string[] {
      const s = new Set<string>()
      if (opts.recordCounter) {
        for (const k of opts.recordCounter.counts.keys()) s.add(k)
      }
      for (const k of cumulativeRecordCount.keys()) s.add(k)
      for (const k of streamStatus.keys()) s.add(k)
      for (const k of completedRanges.keys()) s.add(k)
      return [...s]
    }

    function snapshotWindow() {
      prevWindowTotal = totalRunRecords()
      lastWindowAt = Date.now()
    }

    function buildStreamStatus(stream: string): SyncOutput | undefined {
      const status = streamStatus.get(stream)
      if (!status) return undefined
      const run = runRecordCount(stream)
      const cumulative = (cumulativeRecordCount.get(stream) ?? 0) + run
      return {
        type: 'trace',
        trace: {
          trace_type: 'stream_status' as const,
          stream_status: {
            stream,
            status,
            cumulative_record_count: cumulative,
            run_record_count: run,
          },
        },
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    function buildGlobalProgress(): SyncOutput {
      const windowDuration = Math.max((Date.now() - lastWindowAt) / 1000, 0.001)
      const runRecords = totalRunRecords()
      const globalProgress: TraceGlobalProgress = {
        elapsed_ms: elapsedMs(),
        run_record_count: runRecords,
        cumulative_record_count: cumulativeGlobalRecordCount + runRecords,
        records_per_second: runRecords / elapsedSec(),
        window_records_per_second: totalWindowRecords() / windowDuration,
        state_checkpoint_count: stateCheckpointCount,
        cumulative_request_count: cumulativeRequestCount,
        cumulative_elapsed_ms: cumulativeElapsedMs + elapsedMs(),
      }
      return {
        type: 'trace',
        trace: { trace_type: 'global_progress' as const, global_progress: globalProgress },
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    /** Emit stream_status + global_progress pair if status changed. */
    function* emitIfStatusChanged(stream: string): Iterable<SyncOutput> {
      const current = streamStatus.get(stream)
      if (!current) return
      if (lastEmittedStatus.get(stream) === current) return

      lastEmittedStatus.set(stream, current)
      const ss = buildStreamStatus(stream)
      if (ss) yield ss
      yield buildGlobalProgress()
      snapshotWindow()
    }

    function buildStreamProgress(stream: string, finalEof = false): EofStreamProgress | undefined {
      const status = streamStatus.get(stream)
      if (!status) return undefined
      const run = runRecordCount(stream)
      const cumulative = (cumulativeRecordCount.get(stream) ?? 0) + run
      // At EOF, no stream can still be in-flight — promote 'started' → 'complete'
      const resolvedStatus = finalEof && status === 'started' ? 'complete' : status
      return {
        status: resolvedStatus,
        cumulative_record_count: cumulative,
        run_record_count: run,
        errors: streamErrors.has(stream) ? streamErrors.get(stream) : undefined,
      }
    }

    function buildAccumulatedState(): SyncState | undefined {
      for (const stream of allStreams()) {
        const run = runRecordCount(stream)
        const cumulative = (cumulativeRecordCount.get(stream) ?? 0) + run
        const existing =
          finalState.engine.streams[stream] && typeof finalState.engine.streams[stream] === 'object'
            ? (finalState.engine.streams[stream] as Record<string, unknown>)
            : {}
        finalState.engine.streams[stream] = {
          ...existing,
          cumulative_record_count: cumulative,
          ...(streamStatus.has(stream) ? { status: streamStatus.get(stream) } : {}),
          ...(completedRanges.has(stream) ? { completed_ranges: completedRanges.get(stream) } : {}),
        }
      }

      // Update engine global state with cumulative totals
      const runRecords = totalRunRecords()
      finalState.engine.global = {
        ...finalState.engine.global,
        cumulative_record_count: cumulativeGlobalRecordCount + runRecords,
        cumulative_request_count: cumulativeRequestCount,
        cumulative_elapsed_ms: cumulativeElapsedMs + elapsedMs(),
      }

      const hasAnyState =
        Object.keys(finalState.source.streams).length > 0 ||
        Object.keys(finalState.source.global).length > 0 ||
        Object.keys(finalState.destination.streams).length > 0 ||
        Object.keys(finalState.destination.global).length > 0 ||
        Object.keys(finalState.engine.streams).length > 0 ||
        Object.keys(finalState.engine.global).length > 0

      return hadInitialState || hasAnyState ? finalState : undefined
    }

    function buildEnrichedEof(reason: EofPayload['reason']): SyncOutput {
      const windowDuration = Math.max((Date.now() - lastWindowAt) / 1000, 0.001)
      const streams = allStreams()
      const streamProgressMap: Record<string, EofStreamProgress> = {}
      for (const s of streams) {
        const sp = buildStreamProgress(s, true)
        if (sp) streamProgressMap[s] = sp
      }
      const runRecords = totalRunRecords()
      const eof: EofPayload = {
        reason,
        state: buildAccumulatedState(),
        global_progress: {
          elapsed_ms: elapsedMs(),
          run_record_count: runRecords,
          cumulative_record_count: cumulativeGlobalRecordCount + runRecords,
          records_per_second: runRecords / elapsedSec(),
          window_records_per_second: totalWindowRecords() / windowDuration,
          state_checkpoint_count: stateCheckpointCount,
          cumulative_request_count: cumulativeRequestCount,
          cumulative_elapsed_ms: cumulativeElapsedMs + elapsedMs(),
        },
        stream_progress: Object.keys(streamProgressMap).length > 0 ? streamProgressMap : undefined,
      }
      return {
        type: 'eof',
        eof,
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    // Emit catalog as first message so the UI knows all streams upfront
    if (opts.catalog) {
      yield {
        type: 'catalog',
        catalog: { streams: opts.catalog.streams.map((cs) => cs.stream) },
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    for await (const msg of messages) {
      if (msg.type === 'source_state') {
        stateCheckpointCount++
        if (msg.source_state.state_type === 'stream') {
          const stream = msg.source_state.stream
          finalState.source.streams[stream] = msg.source_state.data
          if (!streamStatus.has(stream)) {
            streamStatus.set(stream, 'started')
            yield* emitIfStatusChanged(stream)
          }
        } else if (msg.source_state.state_type === 'global') {
          finalState.source.global = msg.source_state.data as Record<string, unknown>
        }
      } else if (msg.type === 'trace') {
        if (msg.trace.trace_type === 'stream_status') {
          const ss = msg.trace.stream_status
          if (ss.range_complete) {
            const existing = completedRanges.get(ss.stream) ?? []
            existing.push({ gte: ss.range_complete.gte, lt: ss.range_complete.lt })
            completedRanges.set(ss.stream, mergeRanges(existing))
          }
          const newStatus = ss.status as Status
          if (newStatus === 'started' || newStatus === 'complete') {
            streamStatus.set(ss.stream, newStatus)
            yield* emitIfStatusChanged(ss.stream)
          }
        } else if (msg.trace.trace_type === 'error') {
          const err = msg.trace.error
          if (err.stream) {
            const errs = streamErrors.get(err.stream) ?? []
            errs.push({ message: err.message, failure_type: err.failure_type })
            streamErrors.set(err.stream, errs)
          }
        }
      }

      if (msg.type === 'eof') {
        // Emit final stream_status + global_progress for all streams
        for (const stream of allStreams()) {
          const ss = buildStreamStatus(stream)
          if (ss) yield ss
        }
        yield buildGlobalProgress()
        yield buildEnrichedEof(msg.eof.reason)
        return
      }

      // Suppress upstream stream_status traces — the engine re-emits enriched versions
      if (msg.type === 'trace' && msg.trace.trace_type === 'stream_status') {
        continue
      }

      yield msg
    }
  }
}
