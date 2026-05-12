import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Broadcast,
  OffscreenState,
  ProgressEntry,
  QueryResult,
  SyncStats,
  SyncStatus,
} from '../lib/messaging'

interface StorageInfo {
  has_sync_state: boolean
  sync_state_preview: string | null
  has_api_key: boolean
  using_local_storage: boolean
}

interface FetchLogEntry {
  url: string
  status: number
  ms: number
  ts: number
  sample?: string
}
import { send } from '../lib/messaging'
import { getApiKey } from '../lib/storage'

const DEFAULT_QUERY = 'SELECT * FROM stripe.customers LIMIT 10'

export default function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [stats, setStats] = useState<SyncStats | null>(null)
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [fetchLog, setFetchLog] = useState<FetchLogEntry[] | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const [sql, setSql] = useState(DEFAULT_QUERY)
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshFetchLog = useCallback(async () => {
    const resp = (await send({ kind: 'offscreen:get_fetch_log' }).catch(() => undefined)) as
      | { ok: true; log: FetchLogEntry[] }
      | undefined
    if (resp?.ok) setFetchLog(resp.log)
  }, [])

  const refreshStorageInfo = useCallback(async () => {
    const resp = (await send({ kind: 'offscreen:get_storage_info' }).catch(() => undefined)) as
      | { ok: true; info: StorageInfo }
      | undefined
    if (resp?.ok) setStorageInfo(resp.info)
  }, [])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const key = await getApiKey()
      if (!mounted) return
      setHasKey(Boolean(key))
      await send({ kind: 'panel:ensure_ready' }).catch(() => undefined)
      const resp = (await send({ kind: 'offscreen:get_state' }).catch(() => undefined)) as
        | { ok: true; state: OffscreenState }
        | undefined
      if (mounted && resp?.ok) {
        setStatus(resp.state.status)
        setProgress(resp.state.progress)
        setStats(resp.state.stats)
      }
      await refreshStorageInfo()
    })()
    return () => {
      mounted = false
    }
  }, [refreshStorageInfo])

  useEffect(() => {
    if (status === 'idle' || status === 'done' || status === 'error') {
      refreshStorageInfo()
    }
  }, [status, refreshStorageInfo])

  useEffect(() => {
    const listener = (msg: Broadcast) => {
      if (!msg || typeof msg !== 'object' || !('kind' in msg)) return
      if (msg.kind === 'status') setStatus(msg.status)
      else if (msg.kind === 'progress')
        setProgress((prev) => [...prev.slice(-299), msg.entry])
      else if (msg.kind === 'stats') setStats(msg.stats)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  useEffect(() => {
    if (status !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [status])

  const startSync = useCallback(async () => {
    setBusy(true)
    try {
      const key = await getApiKey()
      if (!key) {
        setHasKey(false)
        return
      }
      await send({ kind: 'panel:ensure_ready' })
      await send({ kind: 'offscreen:start_sync', api_key: key })
    } finally {
      setBusy(false)
    }
  }, [])

  const stopSync = useCallback(async () => {
    await send({ kind: 'offscreen:stop_sync' }).catch(() => undefined)
  }, [])

  const runQuery = useCallback(async () => {
    setQueryError(null)
    setBusy(true)
    try {
      const resp = (await send({ kind: 'offscreen:run_query', sql })) as
        | { ok: true; result: QueryResult }
        | { ok: false; error: string }
      if (resp.ok) setQueryResult(resp.result)
      else {
        setQueryError(resp.error)
        setQueryResult(null)
      }
    } finally {
      setBusy(false)
    }
  }, [sql])

  const clearDb = useCallback(async () => {
    if (!confirm('Drop all synced data?')) return
    setBusy(true)
    try {
      await send({ kind: 'offscreen:clear_db' })
      setQueryResult(null)
      setQueryError(null)
      await refreshStorageInfo()
    } finally {
      setBusy(false)
    }
  }, [refreshStorageInfo])

  const resetState = useCallback(async () => {
    if (!confirm('Forget where the sync left off? (DB preserved.)')) return
    setBusy(true)
    try {
      await send({ kind: 'offscreen:reset_state' })
      await refreshStorageInfo()
    } finally {
      setBusy(false)
    }
  }, [refreshStorageInfo])

  if (hasKey === null) {
    return <div style={containerStyle}>Loading…</div>
  }
  if (!hasKey) {
    return (
      <div style={containerStyle}>
        <h1 style={headerStyle}>Stripe Sync</h1>
        <p>No API key configured.</p>
        <button onClick={() => chrome.runtime.openOptionsPage()} style={buttonStyle}>
          Open settings
        </button>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <h1 style={headerStyle}>Stripe Sync</h1>

      <section style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={statusBadgeStyle(status)}>{status}</span>
          {status === 'running' ? (
            <button onClick={stopSync} disabled={busy} style={buttonStyle}>
              Stop
            </button>
          ) : (
            <button onClick={startSync} disabled={busy} style={buttonStyle}>
              Start sync
            </button>
          )}
          <button
            onClick={resetState}
            disabled={busy || !storageInfo?.has_sync_state}
            style={buttonStyleSecondary}
            title="Forget where sync left off (DB preserved)"
          >
            Reset state
          </button>
          <button onClick={clearDb} disabled={busy} style={buttonStyleSecondary}>
            Clear DB
          </button>
          <button onClick={() => chrome.runtime.openOptionsPage()} style={buttonStyleSecondary}>
            Settings
          </button>
        </div>

        <StorageInfoBanner info={storageInfo} />

        <StatsPanel stats={stats} status={status} now={now} />

        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button onClick={refreshFetchLog} style={buttonStyleSecondary}>
            Refresh fetch log
          </button>
          {fetchLog && (
            <button onClick={() => setFetchLog(null)} style={buttonStyleSecondary}>
              Hide fetch log
            </button>
          )}
        </div>
        {fetchLog && <FetchLogPanel entries={fetchLog} />}

        <div style={logBoxStyle}>
          {progress.length === 0 ? (
            <em style={{ opacity: 0.6 }}>No activity yet.</em>
          ) : (
            progress.map((entry, i) => (
              <div key={i} style={logEntryStyle(entry.level)}>
                <span style={{ opacity: 0.5, marginRight: 6 }}>
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                {entry.text}
              </div>
            ))
          )}
        </div>
      </section>

      <section style={sectionStyle}>
        <label style={labelStyle}>SQL</label>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          style={textareaStyle}
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={runQuery} disabled={busy} style={buttonStyle}>
            Run query
          </button>
          <button
            onClick={() =>
              setSql(
                "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2"
              )
            }
            style={buttonStyleSecondary}
          >
            List tables
          </button>
          <button
            onClick={() =>
              setSql(
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 1"
              )
            }
            style={buttonStyleSecondary}
          >
            List schemas
          </button>
        </div>
        {queryError && <div style={errorStyle}>{queryError}</div>}
        {queryResult && <ResultTable result={queryResult} />}
      </section>
    </div>
  )
}

function FetchLogPanel({ entries }: { entries: FetchLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div style={fetchLogEmptyStyle}>
        No Stripe API calls recorded yet. If you've already started a sync and this is empty, the
        source connector never made an HTTP request — likely failed before reaching the network
        (auth resolution, catalog parsing, etc).
      </div>
    )
  }
  const errors = entries.filter((e) => e.status === 0 || e.status >= 400)
  return (
    <div style={fetchLogBoxStyle}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Stripe API calls: {entries.length} total
        {errors.length > 0 && <span style={{ color: '#c00' }}> ({errors.length} errored)</span>}
      </div>
      {entries
        .slice()
        .reverse()
        .map((e, i) => (
          <div key={i} style={fetchRowStyle(e)}>
            <span style={{ fontFamily: 'monospace', minWidth: 36 }}>{e.status || '✗'}</span>
            <span style={{ fontFamily: 'monospace', minWidth: 50 }}>{e.ms}ms</span>
            <span style={{ fontFamily: 'monospace', flex: 1, wordBreak: 'break-all' }}>
              {e.url.replace(/^https:\/\/[^/]+/, '')}
            </span>
            {e.sample && (e.status === 0 || e.status >= 400) && (
              <details style={{ width: '100%' }}>
                <summary style={{ cursor: 'pointer', fontSize: 10 }}>response sample</summary>
                <pre style={fetchSampleStyle}>{e.sample}</pre>
              </details>
            )}
          </div>
        ))}
    </div>
  )
}

function StorageInfoBanner({ info }: { info: StorageInfo | null }) {
  if (!info) return null
  if (!info.has_sync_state && !info.using_local_storage) return null
  return (
    <div style={infoBannerStyle}>
      {info.using_local_storage && (
        <div>
          chrome.storage unavailable in this context — falling back to localStorage.
        </div>
      )}
      {info.has_sync_state && (
        <details>
          <summary style={{ cursor: 'pointer' }}>
            Saved sync state present — next start will resume from checkpoint
          </summary>
          <pre style={previewStyle}>{info.sync_state_preview}</pre>
        </details>
      )}
    </div>
  )
}

function StatsPanel({
  stats,
  status,
  now,
}: {
  stats: SyncStats | null
  status: SyncStatus
  now: number
}) {
  const elapsed = useMemo(() => {
    if (!stats) return 0
    const end = status === 'running' ? now : stats.last_activity_at
    return Math.max(0, end - stats.started_at)
  }, [stats, status, now])

  const idle = useMemo(() => {
    if (!stats || status !== 'running') return 0
    return Math.max(0, now - stats.last_activity_at)
  }, [stats, status, now])

  if (!stats) return null

  const sortedStreams = [...stats.streams].sort((a, b) => b.records - a.records)
  const stuck = status === 'running' && idle > 10_000

  return (
    <div style={statsBoxStyle}>
      <div style={statsRowStyle}>
        <Pill label="phase" value={stats.phase} />
        <Pill label="elapsed" value={formatDuration(elapsed)} />
        <Pill
          label="last activity"
          value={status === 'running' ? `${formatDuration(idle)} ago` : '—'}
          warn={stuck}
        />
        <Pill label="records" value={stats.total_records.toLocaleString()} />
        <Pill label="streams" value={String(stats.streams.length)} />
      </div>
      {stuck && (
        <div style={stuckStyle}>
          No messages for {formatDuration(idle)}. The engine may be fetching a slow Stripe page,
          processing OAS, or stuck on a network call. Check the offscreen devtools console.
        </div>
      )}
      {sortedStreams.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11 }}>
            {sortedStreams.length} streams
          </summary>
          <table style={{ ...tableStyle, marginTop: 4, width: '100%' }}>
            <thead>
              <tr>
                <th style={thStyle}>stream</th>
                <th style={thStyle}>records</th>
                <th style={thStyle}>status</th>
              </tr>
            </thead>
            <tbody>
              {sortedStreams.map((s) => (
                <tr key={s.stream}>
                  <td style={tdStyle}>{s.stream}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{s.records.toLocaleString()}</td>
                  <td style={{ ...tdStyle, color: streamStatusColor(s.status) }}>
                    {s.status}
                    {s.error ? `: ${s.error}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}

function Pill({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ ...pillStyle, borderColor: warn ? '#c00' : '#ddd' }}>
      <span style={{ opacity: 0.6, marginRight: 4 }}>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h ${remMin}m`
}

function streamStatusColor(s: string): string {
  switch (s) {
    case 'complete':
      return '#0a7'
    case 'running':
      return '#06c'
    case 'error':
      return '#c00'
    case 'skip':
      return '#888'
    default:
      return '#555'
  }
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.rows.length === 0) {
    return <div style={{ marginTop: 8, opacity: 0.7 }}>0 rows</div>
  }
  const cols = result.fields.length > 0 ? result.fields : Object.keys(result.rows[0])
  return (
    <div style={tableWrapperStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={thStyle}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} style={tdStyle}>
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const containerStyle: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minHeight: '100vh',
  boxSizing: 'border-box',
  fontSize: 13,
}
const headerStyle: React.CSSProperties = { fontSize: 16, margin: 0 }
const sectionStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 6,
  padding: 10,
}
const labelStyle: React.CSSProperties = { fontWeight: 600, display: 'block', marginBottom: 4 }
const buttonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 4,
  border: '1px solid #635bff',
  background: '#635bff',
  color: 'white',
  cursor: 'pointer',
}
const buttonStyleSecondary: React.CSSProperties = {
  ...buttonStyle,
  background: 'white',
  color: '#635bff',
}
const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 60,
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 12,
  padding: 6,
  boxSizing: 'border-box',
}
const logBoxStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 11,
  background: '#0b0f19',
  color: '#d6deeb',
  borderRadius: 4,
  padding: 8,
  maxHeight: 200,
  overflowY: 'auto',
}
const errorStyle: React.CSSProperties = { color: '#c00', marginTop: 6, fontFamily: 'monospace' }
const tableWrapperStyle: React.CSSProperties = { overflowX: 'auto', marginTop: 8 }
const tableStyle: React.CSSProperties = { borderCollapse: 'collapse', fontSize: 11 }
const thStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  padding: '4px 6px',
  background: '#f5f5f5',
  textAlign: 'left',
}
const tdStyle: React.CSSProperties = {
  border: '1px solid #eee',
  padding: '3px 6px',
  maxWidth: 240,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
function logEntryStyle(level: ProgressEntry['level']): React.CSSProperties {
  const color = level === 'error' ? '#ff7a7a' : level === 'warn' ? '#ffd06a' : '#82aaff'
  return { color, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
}
const statsBoxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  background: '#f7f7fb',
  borderRadius: 4,
  marginBottom: 8,
  fontSize: 11,
}
const statsRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}
const pillStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 12,
  padding: '2px 8px',
  background: 'white',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
}
const fetchLogBoxStyle: React.CSSProperties = {
  background: '#0b0f19',
  color: '#d6deeb',
  borderRadius: 4,
  padding: 8,
  fontSize: 11,
  maxHeight: 240,
  overflowY: 'auto',
  marginBottom: 8,
}
const fetchLogEmptyStyle: React.CSSProperties = {
  background: '#fff8e1',
  border: '1px solid #ffd54f',
  color: '#5c4400',
  borderRadius: 4,
  padding: '8px 10px',
  fontSize: 11,
  marginBottom: 8,
}
const fetchSampleStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 10,
  background: '#1a1f2e',
  padding: 6,
  marginTop: 4,
  borderRadius: 3,
  maxHeight: 100,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}
function fetchRowStyle(e: FetchLogEntry): React.CSSProperties {
  const color = e.status === 0 ? '#ff7a7a' : e.status >= 400 ? '#ffb347' : e.status >= 300 ? '#ffd06a' : '#82aaff'
  return { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 0', color }
}
const infoBannerStyle: React.CSSProperties = {
  background: '#fff8e1',
  border: '1px solid #ffd54f',
  color: '#5c4400',
  borderRadius: 4,
  padding: '6px 8px',
  fontSize: 11,
  marginBottom: 8,
}
const previewStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 10,
  background: '#fffaee',
  padding: 6,
  marginTop: 4,
  borderRadius: 3,
  maxHeight: 120,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}
const stuckStyle: React.CSSProperties = {
  background: '#ffeaea',
  color: '#900',
  padding: '4px 8px',
  borderRadius: 4,
  fontSize: 11,
}
function statusBadgeStyle(status: SyncStatus): React.CSSProperties {
  const color =
    status === 'running' ? '#0a7' : status === 'error' ? '#c00' : status === 'done' ? '#06c' : '#666'
  return {
    padding: '2px 8px',
    borderRadius: 12,
    background: color,
    color: 'white',
    fontSize: 11,
    textTransform: 'uppercase',
  }
}
