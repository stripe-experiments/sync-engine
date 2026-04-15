import React from 'react'
import { Box, Text } from 'ink'
import type { EofPayload, EofStreamProgress } from '@stripe/sync-protocol'

// ── Formatting helpers ────────────────────────────────────────────

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

function fmtRate(rps: number): string {
  return rps >= 1000 ? `${(rps / 1000).toFixed(1)}k/s` : `${rps.toFixed(1)}/s`
}

// ── Constants ─────────────────────────────────────────────────────

const REASON_COLOR: Record<string, string> = {
  complete: 'green',
  time_limit: 'yellow',
  state_limit: 'blue',
  error: 'red',
  aborted: 'red',
}

const REASON_LABEL: Record<string, string> = {
  complete: 'Sync complete',
  time_limit: 'Time limit reached',
  state_limit: 'State limit reached',
  error: 'Sync failed',
  aborted: 'Sync aborted',
}

const ERROR_COLOR: Record<string, string> = {
  transient_error: 'yellow',
  system_error: 'red',
  config_error: 'magenta',
  auth_error: 'red',
}

const ERROR_LABEL: Record<string, string> = {
  transient_error: 'transient',
  system_error: 'system',
  config_error: 'config',
  auth_error: 'auth',
}

// ── Sub-components ────────────────────────────────────────────────

function Divider({ width = 60 }: { width?: number }) {
  return <Text dimColor>{'─'.repeat(width)}</Text>
}

function StatRow({
  label,
  value,
  dimLabel = false,
}: {
  label: string
  value: string
  dimLabel?: boolean
}) {
  return (
    <Box>
      <Text dimColor={dimLabel}>{label} </Text>
      <Text bold>{value}</Text>
    </Box>
  )
}

function StreamRow({
  name,
  info,
  nameWidth,
  running,
}: {
  name: string
  info: EofStreamProgress
  nameWidth: number
  running: boolean
}) {
  const cum = info.cumulative_record_count
  const run = info.run_record_count
  const isComplete = info.status === 'complete'
  const hasErrors = (info.errors?.length ?? 0) > 0

  return (
    <Box flexDirection="column">
      <Box>
        {/* Status dot */}
        <Box width={3}>
          {isComplete ? (
            <Text color={hasErrors ? 'yellow' : 'green'}>{'✓ '}</Text>
          ) : running ? (
            <Text color="cyan">{'▶ '}</Text>
          ) : (
            <Text dimColor>{'· '}</Text>
          )}
        </Box>
        {/* Stream name */}
        <Box width={nameWidth + 2}>
          <Text color={isComplete ? undefined : running ? 'cyan' : 'gray'} wrap="truncate">
            {name.padEnd(nameWidth)}
          </Text>
        </Box>
        {/* Cumulative count */}
        <Box width={10} justifyContent="flex-end">
          <Text dimColor={cum === 0}>{cum > 0 ? fmt(cum) : '—'}</Text>
        </Box>
        {/* Run delta */}
        <Box width={10} justifyContent="flex-end">
          {run > 0 ? <Text color="green"> +{fmt(run)}</Text> : null}
        </Box>
      </Box>

      {/* Per-stream errors */}
      {(info.errors ?? []).map((err, i) => (
        <Box key={i} paddingLeft={5}>
          <Text color={ERROR_COLOR[err.failure_type ?? 'system_error'] ?? 'red'}>
            [{ERROR_LABEL[err.failure_type ?? 'system_error'] ?? 'error'}] {err.message}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// ── Main component ────────────────────────────────────────────────

export interface SyncProgressProps {
  eof: EofPayload
  catalog: string[]
  final: boolean
  /** Number of pipeline_sync calls made so far (backfill mode) */
  attempt?: number
}

export function SyncProgressUI({ eof, catalog, final, attempt }: SyncProgressProps) {
  const gp = eof.global_progress
  const sp = eof.stream_progress ?? {}

  // Partition streams
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

  const allStreamNames = [...complete.map((c) => c[0]), ...started.map((s) => s[0]), ...pending]
  const nameWidth = Math.max(...allStreamNames.map((n) => n.length), 12)

  const errCount = Object.values(sp).filter((i) => (i.errors?.length ?? 0) > 0).length
  const reasonColor = REASON_COLOR[eof.reason] ?? 'white'
  const reasonLabel = REASON_LABEL[eof.reason] ?? eof.reason

  return (
    <Box flexDirection="column" paddingTop={0}>
      {/* ── Header ── */}
      <Box marginBottom={1}>
        {final ? (
          <Box gap={1}>
            <Text bold color={reasonColor}>
              {reasonLabel}
            </Text>
            {attempt != null && attempt > 1 && <Text dimColor>({attempt} attempts)</Text>}
          </Box>
        ) : (
          <Box>
            <Text bold color="cyan">
              Syncing
            </Text>
            {attempt != null && attempt > 1 && <Text dimColor> · attempt {attempt}</Text>}
            {gp && (
              <Text dimColor>
                {' '}
                · {fmtDuration(gp.elapsed_ms)}
                {gp.window_records_per_second != null && gp.window_records_per_second > 0
                  ? ` · ${fmtRate(gp.window_records_per_second)}`
                  : ''}
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* ── Global stats ── */}
      {gp && (
        <Box flexDirection="column" marginBottom={1}>
          <Divider />
          <Box gap={3} flexWrap="wrap">
            <StatRow
              label="Records"
              value={`${fmt(gp.cumulative_record_count ?? gp.run_record_count)}${
                gp.run_record_count > 0 && (gp.cumulative_record_count ?? 0) > gp.run_record_count
                  ? ` (+${fmt(gp.run_record_count)} this run)`
                  : ''
              }`}
            />
            <StatRow
              label="Requests"
              value={fmt(gp.cumulative_request_count ?? gp.request_count ?? 0)}
            />
            <StatRow
              label="Elapsed"
              value={fmtDuration(gp.cumulative_elapsed_ms ?? gp.elapsed_ms)}
            />
            {final && gp.records_per_second > 0 && (
              <StatRow label="Avg rate" value={fmtRate(gp.records_per_second)} />
            )}
          </Box>
          <Divider />
        </Box>
      )}

      {/* ── Stream table header ── */}
      {allStreamNames.length > 0 && (
        <Box marginBottom={0}>
          <Box width={3} />
          <Box width={nameWidth + 2}>
            <Text dimColor bold>
              {'stream'.padEnd(nameWidth)}
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text dimColor bold>
              total
            </Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text dimColor bold>
              this run
            </Text>
          </Box>
        </Box>
      )}

      {/* ── Complete streams ── */}
      {complete.length > 0 && (
        <Box flexDirection="column" marginBottom={started.length > 0 || pending.length > 0 ? 1 : 0}>
          {complete.map(([name, info]) => (
            <StreamRow key={name} name={name} info={info} nameWidth={nameWidth} running={false} />
          ))}
        </Box>
      )}

      {/* ── In-progress streams ── */}
      {started.length > 0 && (
        <Box flexDirection="column" marginBottom={pending.length > 0 ? 1 : 0}>
          {started.map(([name, info]) => (
            <StreamRow key={name} name={name} info={info} nameWidth={nameWidth} running={true} />
          ))}
        </Box>
      )}

      {/* ── Pending streams (collapsed) ── */}
      {pending.length > 0 && (
        <Box marginBottom={1}>
          <Box width={3}>
            <Text dimColor>{'· '}</Text>
          </Box>
          <Text dimColor>
            {pending.length} pending: {pending.slice(0, 5).join(', ')}
            {pending.length > 5 ? ` +${pending.length - 5} more` : ''}
          </Text>
        </Box>
      )}

      {/* ── Footer summary ── */}
      {complete.length + started.length + pending.length > 0 && (
        <Box>
          <Divider />
        </Box>
      )}
      <Box gap={2} flexWrap="wrap">
        {complete.length > 0 && <Text color="green">{complete.length} complete</Text>}
        {started.length > 0 && <Text color="cyan">{started.length} in progress</Text>}
        {pending.length > 0 && <Text dimColor>{pending.length} pending</Text>}
        {errCount > 0 && <Text color="yellow">{errCount} with errors</Text>}
        {gp && gp.run_record_count > 0 && (
          <Text dimColor>+{fmt(gp.run_record_count)} records this run</Text>
        )}
        {eof.cutoff && <Text color="yellow">cutoff: {eof.cutoff}</Text>}
      </Box>
    </Box>
  )
}
