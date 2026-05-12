import { PGlite } from '@electric-sql/pglite'
import { runSync } from './lib/sync'
import { clearSyncState } from './lib/storage'
import {
  broadcast,
  type ProgressEntry,
  type Request,
  type StreamStats,
  type SyncStats,
  type SyncStatus,
} from './lib/messaging'

const originalFetch = globalThis.fetch.bind(globalThis)
const fetchLog: Array<{ url: string; status: number; ms: number; ts: number; sample?: string }> = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const isStripe = url.includes('api.stripe.com') || url.includes('files.stripe.com')
  if (!isStripe) return originalFetch(input, init)

  const start = Date.now()
  const ts = start
  try {
    const res = await originalFetch(input, init)
    const ms = Date.now() - start
    const clone = res.clone()
    const sample = await clone.text().catch(() => '').then((t) => t.slice(0, 400))
    fetchLog.push({ url, status: res.status, ms, ts, sample })
    if (fetchLog.length > 200) fetchLog.shift()
    console.log('[stripe fetch]', res.status, ms + 'ms', url.replace(/^https:\/\/[^/]+/, ''))
    if (res.status >= 400) console.warn('[stripe error]', res.status, url, sample)
    return res
  } catch (err) {
    const ms = Date.now() - start
    fetchLog.push({ url, status: 0, ms, ts, sample: err instanceof Error ? err.message : String(err) })
    if (fetchLog.length > 200) fetchLog.shift()
    console.error('[stripe fetch failed]', url, err)
    throw err
  }
}) as typeof fetch

const PGLITE_DATA_DIR = 'idb://stripe-sync'
const MAX_PROGRESS = 500
const STATS_HEARTBEAT_MS = 1500

const state = {
  status: 'idle' as SyncStatus,
  progress: [] as ProgressEntry[],
  controller: null as AbortController | null,
  stats: null as SyncStats | null,
  streamMap: new Map<string, StreamStats>(),
  heartbeat: null as ReturnType<typeof setInterval> | null,
}

function snapshotStats(): SyncStats | null {
  return state.stats ? { ...state.stats, streams: Array.from(state.streamMap.values()) } : null
}

function emitStats(): void {
  const s = snapshotStats()
  if (s) broadcast({ kind: 'stats', stats: s })
}

function pushProgress(level: ProgressEntry['level'], text: string): void {
  const entry: ProgressEntry = { timestamp: Date.now(), level, text }
  state.progress.push(entry)
  if (state.progress.length > MAX_PROGRESS) state.progress.shift()
  broadcast({ kind: 'progress', entry })
  if (state.stats) state.stats.last_activity_at = entry.timestamp
}

function setStatus(next: SyncStatus): void {
  state.status = next
  broadcast({ kind: 'status', status: next })
}

function ensureStream(name: string): StreamStats {
  let s = state.streamMap.get(name)
  if (!s) {
    s = { stream: name, records: 0, status: 'pending' }
    state.streamMap.set(name, s)
  }
  return s
}

function setPhase(phase: string): void {
  if (state.stats) state.stats.phase = phase
  emitStats()
}

interface StreamProgressLike {
  status?: string
  record_count?: number
  message?: string
}

interface ProgressPayloadLike {
  derived?: { total_record_count?: number }
  streams?: Record<string, StreamProgressLike>
}

type AnyMsg = {
  type?: string
  log?: { level?: string; message?: string; [k: string]: unknown }
  stream_status?: { stream?: string; status?: string; error?: string }
  control?: { control_type?: string; [k: string]: unknown }
  connection_status?: { status?: string; message?: string }
  source_state?: unknown
  progress?: ProgressPayloadLike
  eof?: { run_progress?: ProgressPayloadLike }
}

function applyProgressPayload(p: ProgressPayloadLike | undefined): void {
  if (!p) return
  const total = p.derived?.total_record_count
  if (typeof total === 'number' && state.stats) {
    state.stats.total_records = total
    state.stats.last_activity_at = Date.now()
  }
  for (const [name, sp] of Object.entries(p.streams ?? {})) {
    const s = ensureStream(name)
    if (typeof sp.record_count === 'number') s.records = sp.record_count
    if (sp.status === 'started') s.status = 'running'
    else if (sp.status === 'completed') s.status = 'complete'
    else if (sp.status === 'errored') {
      s.status = 'error'
      s.error = sp.message
    } else if (sp.status === 'skipped') s.status = 'skip'
  }
}

function handleMessage(raw: unknown): void {
  const m = raw as AnyMsg
  if (!m || !m.type) return

  switch (m.type) {
    case 'stream_status': {
      const name = m.stream_status?.stream ?? 'unknown'
      const status = m.stream_status?.status
      const s = ensureStream(name)
      if (status === 'start') s.status = 'running'
      else if (status === 'complete' || status === 'range_complete') s.status = 'complete'
      else if (status === 'error') {
        s.status = 'error'
        s.error = m.stream_status?.error
      } else if (status === 'skip') s.status = 'skip'
      pushProgress(status === 'error' ? 'error' : 'info', `stream ${name} ${status ?? ''}${m.stream_status?.error ? `: ${m.stream_status.error}` : ''}`)
      break
    }
    case 'log': {
      const lvl = m.log?.level
      const level: ProgressEntry['level'] = lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'info'
      const msg = m.log?.message ?? JSON.stringify(m.log).slice(0, 200)
      pushProgress(level, `log: ${msg}`)
      break
    }
    case 'progress': {
      applyProgressPayload(m.progress)
      const total = m.progress?.derived?.total_record_count
      pushProgress('info', `progress: ${total ?? '?'} records total`)
      break
    }
    case 'control': {
      const ct = m.control?.control_type
      pushProgress('info', `control: ${ct ?? ''}`)
      if (ct === 'source_config') setPhase('source configured')
      else if (ct === 'destination_config') setPhase('destination configured')
      break
    }
    case 'connection_status': {
      const cs = m.connection_status
      const level: ProgressEntry['level'] = cs?.status === 'failed' ? 'error' : 'info'
      pushProgress(level, `connection ${cs?.status ?? ''}${cs?.message ? `: ${cs.message}` : ''}`)
      break
    }
    case 'source_state': {
      pushProgress('info', 'state checkpoint saved')
      break
    }
    case 'eof': {
      applyProgressPayload(m.eof?.run_progress)
      const total = m.eof?.run_progress?.derived?.total_record_count
      pushProgress('info', `eof — ${total ?? 0} records total`)
      break
    }
    default: {
      pushProgress('info', m.type)
    }
  }
  emitStats()
}

async function startSync(apiKey: string): Promise<void> {
  if (state.status === 'running') {
    pushProgress('warn', 'sync already running')
    return
  }
  state.progress = []
  state.streamMap.clear()
  state.stats = {
    started_at: Date.now(),
    last_activity_at: Date.now(),
    total_records: 0,
    streams: [],
    phase: 'starting',
  }
  setStatus('running')
  state.controller = new AbortController()
  pushProgress('info', 'starting sync')
  emitStats()

  state.heartbeat = setInterval(() => {
    if (state.stats) state.stats.last_activity_at = state.stats.last_activity_at
    emitStats()
  }, STATS_HEARTBEAT_MS)

  try {
    setPhase('setup')
    await runSync({
      apiKey,
      signal: state.controller.signal,
      onMessage: handleMessage,
      onPhase: setPhase,
    })
    if (state.controller.signal.aborted) {
      pushProgress('warn', 'sync stopped')
      setStatus('idle')
    } else {
      setPhase('complete')
      pushProgress('info', 'sync complete')
      setStatus('done')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack ? err.stack : ''
    console.error('[offscreen] sync failed', err)
    pushProgress('error', `sync failed: ${message}`)
    if (stack) pushProgress('error', stack.split('\n').slice(0, 6).join('\n'))
    setStatus('error')
  } finally {
    if (state.heartbeat) {
      clearInterval(state.heartbeat)
      state.heartbeat = null
    }
    emitStats()
    state.controller = null
  }
}

function stopSync(): void {
  state.controller?.abort()
}

async function runQuery(sqlText: string): Promise<{ rows: Record<string, unknown>[]; fields: string[] }> {
  if (state.status === 'running') {
    throw new Error('Sync is running; stop it before querying.')
  }
  const db = await PGlite.create(PGLITE_DATA_DIR)
  try {
    const result = await db.query(sqlText)
    const rows = result.rows as Record<string, unknown>[]
    const fields = (result.fields ?? []).map((f) => f.name)
    return { rows, fields }
  } finally {
    await db.close()
  }
}

async function clearDb(): Promise<void> {
  if (state.status === 'running') throw new Error('Sync is running; stop it first.')
  const db = await PGlite.create(PGLITE_DATA_DIR)
  try {
    await db.exec('DROP SCHEMA IF EXISTS "stripe" CASCADE')
  } finally {
    await db.close()
  }
  await clearSyncState()
  state.progress = []
  state.streamMap.clear()
  state.stats = null
  setStatus('idle')
  pushProgress('info', 'database cleared')
}

async function resetState(): Promise<void> {
  if (state.status === 'running') throw new Error('Sync is running; stop it first.')
  await clearSyncState()
  pushProgress('info', 'sync state cleared (DB preserved)')
}

interface StorageInfo {
  has_sync_state: boolean
  sync_state_preview: string | null
  has_api_key: boolean
  using_local_storage: boolean
}

async function getStorageInfo(): Promise<StorageInfo> {
  const usingChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local
  const rawState = usingChrome
    ? (await chrome.storage.local.get('sync_state')).sync_state
    : (() => {
        try {
          const raw = localStorage.getItem('sync_state')
          return raw ? JSON.parse(raw) : undefined
        } catch {
          return undefined
        }
      })()
  const rawKey = usingChrome
    ? (await chrome.storage.local.get('stripe_api_key')).stripe_api_key
    : (() => {
        try {
          const raw = localStorage.getItem('stripe_api_key')
          return raw ? JSON.parse(raw) : undefined
        } catch {
          return undefined
        }
      })()
  return {
    has_sync_state: rawState !== undefined && rawState !== null,
    sync_state_preview: rawState ? JSON.stringify(rawState).slice(0, 400) : null,
    has_api_key: typeof rawKey === 'string' && rawKey.length > 0,
    using_local_storage: !usingChrome,
  }
}

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('kind' in message)) return false

  switch (message.kind) {
    case 'offscreen:get_state':
      sendResponse({
        ok: true,
        state: { status: state.status, progress: state.progress, stats: snapshotStats() },
      })
      return false
    case 'offscreen:start_sync':
      startSync(message.api_key).catch(() => {})
      sendResponse({ ok: true })
      return false
    case 'offscreen:stop_sync':
      stopSync()
      sendResponse({ ok: true })
      return false
    case 'offscreen:run_query':
      runQuery(message.sql)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    case 'offscreen:clear_db':
      clearDb()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    case 'offscreen:reset_state':
      resetState()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    case 'offscreen:get_storage_info':
      getStorageInfo()
        .then((info) => sendResponse({ ok: true, info }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    case 'offscreen:get_fetch_log':
      sendResponse({ ok: true, log: fetchLog.slice(-100) })
      return false
    default:
      return false
  }
})

broadcast({ kind: 'status', status: state.status })
