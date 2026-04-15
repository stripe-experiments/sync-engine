import type {
  SyncOutput,
  EofPayload,
  EofStreamProgress,
  TraceGlobalProgress,
} from '@stripe/sync-protocol'

// ── Reducer: SyncOutput messages → EofPayload ────────────────────
//
// At any point during a sync, the accumulated state is a valid EofPayload.
// The final EOF message from the engine replaces it wholesale.
// Display is purely a function of (EofPayload, catalog).

export interface SyncDisplayState {
  catalog: string[]
  eof: EofPayload
}

export function createSyncDisplayState(): {
  state: SyncDisplayState
  /** Returns true if the message changed the display state. */
  update: (msg: SyncOutput) => boolean
} {
  const state: SyncDisplayState = {
    catalog: [],
    eof: { reason: 'complete' },
  }

  function ensureStream(name: string): EofStreamProgress {
    if (!state.eof.stream_progress) state.eof.stream_progress = {}
    if (!state.eof.stream_progress[name]) {
      state.eof.stream_progress[name] = {
        status: 'started',
        cumulative_record_count: 0,
        run_record_count: 0,
      }
    }
    return state.eof.stream_progress[name]
  }

  function update(msg: SyncOutput): boolean {
    if (msg.type === 'catalog') {
      state.catalog = (msg.catalog as { streams: Array<{ name: string }> }).streams.map(
        (s) => s.name
      )
      return true
    }

    if (msg.type === 'trace') {
      const t = msg.trace
      if (t.trace_type === 'stream_status') {
        const ss = t.stream_status
        const sp = ensureStream(ss.stream)
        sp.status = ss.status as 'started' | 'complete'
        if (ss.cumulative_record_count != null) sp.cumulative_record_count = ss.cumulative_record_count
        if (ss.run_record_count != null) sp.run_record_count = ss.run_record_count
        return true
      }
      if (t.trace_type === 'global_progress') {
        state.eof.global_progress = (
          t as { trace_type: 'global_progress'; global_progress: TraceGlobalProgress }
        ).global_progress
        return false // rendered with preceding stream_status
      }
      if (t.trace_type === 'error') {
        const err = (
          t as {
            trace_type: 'error'
            error: { message: string; failure_type?: string; stream?: string }
          }
        ).error
        if (err.stream) {
          const sp = ensureStream(err.stream)
          if (!sp.errors) sp.errors = []
          sp.errors.push({
            message: err.message,
            failure_type: err.failure_type as 'config_error' | 'system_error' | 'transient_error' | 'auth_error' | undefined,
          })
        }
        return false
      }
    }

    if (msg.type === 'eof') {
      // The engine's EOF is authoritative — replace everything
      state.eof = msg.eof
      return true
    }

    return false
  }

  return { state, update }
}

// ── Renderer: (EofPayload, catalog) → string[] ──────────────────

const ERROR_EMOJI: Record<string, string> = {
  transient_error: '⚠️',
  system_error: '❌',
  config_error: '⚙️',
  auth_error: '🔒',
}

const REASON_EMOJI: Record<string, string> = {
  complete: '✅',
  time_limit: '⏱️',
  state_limit: '📦',
  error: '❌',
  aborted: '🛑',
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return rm > 0 ? `${hrs}h ${rm}m` : `${hrs}h`
}

/**
 * Render a sync progress table from an EofPayload and optional catalog.
 * Pure function — no side effects. Returns an array of lines.
 *
 * @param eof - The current (or final) EOF payload
 * @param catalog - Stream names from the catalog (to derive pending streams)
 * @param final - True when rendering after the actual EOF message (changes header)
 */
export function renderSyncProgress(
  eof: EofPayload,
  catalog: string[] = [],
  final = false
): string[] {
  const lines: string[] = []
  const gp = eof.global_progress

  // Header
  if (final) {
    lines.push(`${REASON_EMOJI[eof.reason] ?? '❓'} Sync ${eof.reason}`)
  } else {
    lines.push('🔄 Syncing...')
  }

  if (gp) {
    const cumRecords = gp.cumulative_record_count ?? gp.run_record_count
    const cumElapsed = gp.cumulative_elapsed_ms ?? gp.elapsed_ms
    lines.push(
      `   Total: ${fmt(cumRecords)} records | ${fmt(gp.cumulative_request_count ?? 0)} requests | ${fmtDuration(cumElapsed)}`
    )
    lines.push(
      `   This run: +${fmt(gp.run_record_count)} records | ${fmt(gp.request_count ?? 0)} requests | ${fmtDuration(gp.elapsed_ms)} | ${gp.records_per_second.toFixed(1)} records/s`
    )
  }

  // Group streams by status
  const sp = eof.stream_progress ?? {}
  const complete: [string, EofStreamProgress][] = []
  const started: [string, EofStreamProgress][] = []
  const pending: string[] = []

  const known = new Set(Object.keys(sp))
  for (const [name, info] of Object.entries(sp)) {
    if (info.status === 'complete') complete.push([name, info])
    else started.push([name, info])
  }
  for (const name of catalog) {
    if (!known.has(name)) pending.push(name)
  }

  complete.sort((a, b) => b[1].cumulative_record_count - a[1].cumulative_record_count)
  started.sort((a, b) => b[1].cumulative_record_count - a[1].cumulative_record_count)

  const allNames = [...complete.map((c) => c[0]), ...started.map((s) => s[0]), ...pending]
  const maxName = Math.max(...allNames.map((n) => n.length), 10)

  function streamLine(name: string, info: EofStreamProgress) {
    const cum = info.cumulative_record_count
    const run = info.run_record_count
    const countStr =
      cum > 0 ? `${fmt(cum).padStart(10)}${run > 0 ? ` (+${fmt(run)})` : ''}` : ''
    lines.push(`    ${name.padEnd(maxName)}  ${countStr}`)
    for (const err of info.errors ?? []) {
      const emoji = ERROR_EMOJI[err.failure_type ?? 'system_error'] ?? '❌'
      lines.push(`      ${emoji} ${err.message}${err.failure_type ? ` (${err.failure_type})` : ''}`)
    }
  }

  lines.push('')
  if (complete.length > 0) {
    lines.push(`  ✅ Complete (${complete.length}):`)
    for (const [name, info] of complete) streamLine(name, info)
  }
  if (started.length > 0) {
    lines.push(`  🔄 Started (${started.length}):`)
    for (const [name, info] of started) streamLine(name, info)
  }
  if (pending.length > 0) {
    lines.push(`  ⏳ Pending (${pending.length}):`)
    lines.push(`    ${pending.join(', ')}`)
  }

  // Summary
  const errCount = Object.values(sp).filter((i) => (i.errors?.length ?? 0) > 0).length
  lines.push('')
  const parts: string[] = []
  if (complete.length) parts.push(`${complete.length} complete`)
  if (started.length) parts.push(`${started.length} started`)
  if (pending.length) parts.push(`${pending.length} pending`)
  if (errCount) parts.push(`${errCount} with errors`)
  parts.push(`+${fmt(gp?.run_record_count ?? 0)} records this run`)
  lines.push(`  📊 ${parts.join(' | ')}`)

  return lines
}
