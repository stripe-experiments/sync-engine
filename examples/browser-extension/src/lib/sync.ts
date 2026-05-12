import { createEngine, createConnectorResolver } from '@stripe/sync-engine/lib'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres/pglite'
import { loadSyncState, saveSyncState } from './storage'

export interface SyncOptions {
  apiKey: string
  onMessage?: (msg: unknown) => void
  onPhase?: (phase: string) => void
  signal?: AbortSignal
}

const PGLITE_DATA_DIR = 'idb://stripe-sync'
const SCHEMA = 'stripe'

function buildPipeline(apiKey: string) {
  return {
    source: {
      type: 'stripe' as const,
      stripe: { api_key: apiKey, websocket: false },
    },
    destination: {
      type: 'postgres' as const,
      postgres: {
        schema: SCHEMA,
        pglite: { data_dir: PGLITE_DATA_DIR },
        allow_experimental_pglite: true,
        batch_size: 50,
      },
    },
  }
}

export async function runSync({
  apiKey,
  onMessage,
  onPhase,
  signal,
}: SyncOptions): Promise<void> {
  onPhase?.('resolving connectors')
  const resolver = await createConnectorResolver({
    sources: { stripe: sourceStripe },
    destinations: { postgres: destinationPostgres },
  })
  onPhase?.('creating engine')
  const engine = await createEngine(resolver)
  const pipeline = buildPipeline(apiKey)

  onPhase?.('pipeline setup')
  let catalogStreams = 0
  for await (const msg of engine.pipeline_setup(pipeline)) {
    onMessage?.(msg)
    const m = msg as { type?: string; control?: { control_type?: string; catalog?: { streams?: unknown[] } } }
    if (m.type === 'control' && m.control?.catalog?.streams) {
      catalogStreams = m.control.catalog.streams.length
      onMessage?.({ type: 'log', log: { level: 'info', message: `catalog: ${catalogStreams} streams discovered` } })
      console.log('[sync] catalog streams', m.control.catalog.streams.map((s: { stream?: { name?: string } }) => s.stream?.name))
    }
    if (signal?.aborted) return
  }
  if (catalogStreams === 0) {
    onMessage?.({ type: 'log', log: { level: 'warn', message: 'catalog has 0 streams — source did not discover any tables' } })
  }

  const prior = await loadSyncState()
  const syncOpts = prior ? { state: prior as Record<string, unknown> } : {}
  onPhase?.(prior ? 'resuming sync' : 'starting sync')

  let recordsWritten = 0
  let pendingState: unknown = null
  let hadErrors = false
  const streamCounts = new Map<string, number>()

  for await (const msg of engine.pipeline_sync(pipeline, syncOpts)) {
    onMessage?.(msg)
    const m = msg as {
      type?: string
      source_state?: unknown
      stream_status?: { status?: string; stream?: string; error?: string }
      progress?: {
        derived?: { total_record_count?: number }
        streams?: Record<string, { record_count?: number }>
      }
      eof?: { run_progress?: { derived?: { total_record_count?: number }; streams?: Record<string, { record_count?: number }> } }
      connection_status?: { status?: string; message?: string }
    }
    if (m.type === 'progress' && m.progress) {
      recordsWritten = m.progress.derived?.total_record_count ?? recordsWritten
      for (const [name, sp] of Object.entries(m.progress.streams ?? {})) {
        streamCounts.set(name, sp.record_count ?? 0)
      }
    } else if (m.type === 'eof' && m.eof?.run_progress) {
      recordsWritten = m.eof.run_progress.derived?.total_record_count ?? recordsWritten
      for (const [name, sp] of Object.entries(m.eof.run_progress.streams ?? {})) {
        streamCounts.set(name, sp.record_count ?? 0)
      }
    } else if (m.type === 'stream_status') {
      const ss = m.stream_status
      console.log('[sync] stream_status', ss?.stream, ss?.status, ss?.error ?? '')
      if (ss?.status === 'error') hadErrors = true
    } else if (m.type === 'connection_status') {
      console.warn('[sync] connection_status', m.connection_status)
    } else if (m.type === 'source_state' && m.source_state) {
      pendingState = m.source_state
    }

    if (pendingState && recordsWritten > 0) {
      await saveSyncState(pendingState)
      pendingState = null
    }

    if (signal?.aborted) return
  }

  console.log('[sync] final stream counts', Object.fromEntries(streamCounts))
  onMessage?.({
    type: 'log',
    log: {
      level: 'info',
      message: `final: ${recordsWritten} records across ${streamCounts.size} streams`,
    },
  })

  if (recordsWritten === 0 && hadErrors) {
    onMessage?.({ type: 'log', log: { level: 'warn', message: 'no records written; state not persisted' } })
  } else if (pendingState && recordsWritten > 0) {
    await saveSyncState(pendingState)
  }
}
