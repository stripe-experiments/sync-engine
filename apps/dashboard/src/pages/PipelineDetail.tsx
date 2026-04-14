import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getPipeline,
  pausePipeline,
  resumePipeline,
  deletePipeline,
  type Pipeline,
} from '@/lib/api'
import { inferGroupName } from '@/lib/stream-groups'
import { cn } from '@/lib/utils'

interface StreamProgress {
  status: string
  cumulative_record_count: number
  run_record_count: number
  window_record_count: number
  records_per_second: number
  errors?: Array<{ message: string; failure_type?: string }>
}

interface GlobalProgress {
  elapsed_ms: number
  run_record_count: number
  rows_per_second: number
  window_rows_per_second: number
  state_checkpoint_count: number
}

interface PipelineDetailProps {
  id: string
  onBack: () => void
}

export function PipelineDetail({ id, onBack }: PipelineDetailProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [streamProgress, setStreamProgress] = useState<Record<string, StreamProgress>>({})
  const [globalProgress, setGlobalProgress] = useState<GlobalProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setPipeline(await getPipeline(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipeline')
    } finally {
      setLoading(false)
    }
  }

  const startSyncStream = useCallback(async (pipelineConfig: Record<string, unknown>) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/engine/pipeline_sync', {
        method: 'POST',
        headers: {
          'x-pipeline': JSON.stringify(pipelineConfig),
        },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line) as Record<string, unknown>
            if (msg.type === 'trace') {
              const trace = msg.trace as Record<string, unknown>
              if (trace.trace_type === 'stream_status') {
                const ss = trace.stream_status as StreamProgress & { stream: string }
                if (ss.cumulative_record_count !== undefined) {
                  setStreamProgress((prev) => ({ ...prev, [ss.stream]: ss }))
                }
              } else if (trace.trace_type === 'progress') {
                setGlobalProgress(trace.progress as GlobalProgress)
              }
            } else if (msg.type === 'eof') {
              const eof = msg.eof as Record<string, unknown>
              if (eof.global_progress) setGlobalProgress(eof.global_progress as GlobalProgress)
              if (eof.stream_progress) {
                const sp = eof.stream_progress as Record<string, StreamProgress>
                setStreamProgress((prev) => ({ ...prev, ...sp }))
              }
            }
          } catch {
            // skip unparseable lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Sync stream error:', err)
      }
    }
  }, [])

  useEffect(() => {
    load()
    return () => abortRef.current?.abort()
  }, [id])

  useEffect(() => {
    if (!pipeline || pipeline.desired_status !== 'active') return
    const status = pipeline.status
    if (status === 'backfill' || status === 'ready') {
      const { id: _, ...config } = pipeline as Record<string, unknown>
      startSyncStream(config as Record<string, unknown>)
    }
    return () => abortRef.current?.abort()
  }, [pipeline?.status, pipeline?.desired_status, startSyncStream])

  async function handlePause() {
    setActing(true)
    try {
      abortRef.current?.abort()
      setPipeline(await pausePipeline(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pause failed')
    } finally {
      setActing(false)
    }
  }

  async function handleResume() {
    setActing(true)
    try {
      setPipeline(await resumePipeline(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setActing(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete pipeline ${id}?`)) return
    setActing(true)
    try {
      abortRef.current?.abort()
      await deletePipeline(id)
      onBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    )
  }

  if (!pipeline) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <button onClick={onBack} className="text-sm text-indigo-600 hover:text-indigo-700">
          Back to pipelines
        </button>
      </div>
    )
  }

  const sourceType = String(pipeline.source?.type ?? 'unknown')
  const destType = String(pipeline.destination?.type ?? 'unknown')
  const phase = pipeline.status ?? 'unknown'
  const paused = pipeline.desired_status === 'paused'
  const streams = pipeline.streams ?? []

  return (
    <div className="mx-auto max-w-4xl p-8">
      <button onClick={onBack} className="mb-4 text-sm text-indigo-600 hover:text-indigo-700">
        Pipelines &rsaquo;
      </button>

      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-100 text-xl">
            {sourceType === 'stripe' ? '💳' : '📦'}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">
                {sourceType} → {destType}
              </h1>
              <StatusBadge phase={phase} paused={paused} />
            </div>
            <p className="text-sm text-gray-500">{pipeline.id}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {paused ? (
            <button
              disabled={acting}
              onClick={handleResume}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Resume
            </button>
          ) : (
            <button
              disabled={acting}
              onClick={handlePause}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Pause
            </button>
          )}
          <button
            disabled={acting}
            onClick={handleDelete}
            className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Global progress stats */}
      {globalProgress && (
        <div className="mb-6 grid grid-cols-4 gap-4">
          <StatCard label="Total rows" value={formatNumber(globalProgress.run_record_count)} />
          <StatCard
            label="Throughput"
            value={`${formatNumber(Math.round(globalProgress.rows_per_second))}/s`}
          />
          <StatCard
            label="Instantaneous"
            value={`${formatNumber(Math.round(globalProgress.window_rows_per_second))}/s`}
          />
          <StatCard label="Elapsed" value={formatDuration(globalProgress.elapsed_ms)} />
        </div>
      )}

      {/* Tables synced */}
      <h2 className="mb-4 text-xl font-semibold">Tables synced</h2>

      {streams.length === 0 ? (
        <p className="text-sm text-gray-400">No tables configured</p>
      ) : (
        <>
          <p className="mb-4 text-sm text-gray-500">
            Viewing {streams.length} {streams.length === 1 ? 'result' : 'results'}
          </p>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-sm font-medium text-gray-600">
                  <th className="px-4 py-3">Table</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Rows synced</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {streams
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((stream) => {
                    const progress = streamProgress[stream.name]
                    return (
                      <tr key={stream.name} className="text-sm hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {formatTableName(stream.name)}
                        </td>
                        <td className="px-4 py-3 text-gray-500">{inferGroupName(stream.name)}</td>
                        <td className="px-4 py-3">
                          {progress ? (
                            <StreamStatusBadge status={progress.status} />
                          ) : (
                            <span className="text-gray-400">--</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                          {progress ? formatNumber(progress.cumulative_record_count) : '--'}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function StreamStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    started: 'bg-blue-100 text-blue-700',
    running: 'bg-green-100 text-green-700',
    complete: 'bg-gray-100 text-gray-700',
    incomplete: 'bg-yellow-100 text-yellow-700',
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        colors[status] ?? 'bg-gray-100 text-gray-600'
      )}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function StatusBadge({ phase, paused }: { phase: string; paused: boolean }) {
  if (paused) {
    return (
      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
        Paused
      </span>
    )
  }
  const colors: Record<string, string> = {
    running: 'bg-green-100 text-green-700',
    setup: 'bg-blue-100 text-blue-700',
    backfill: 'bg-blue-100 text-blue-700',
    ready: 'bg-green-100 text-green-700',
    complete: 'bg-gray-100 text-gray-700',
    error: 'bg-red-100 text-red-700',
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        colors[phase] ?? 'bg-gray-100 text-gray-600'
      )}
    >
      {phase.charAt(0).toUpperCase() + phase.slice(1)}
    </span>
  )
}

function formatTableName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h ${remMin}m`
}
