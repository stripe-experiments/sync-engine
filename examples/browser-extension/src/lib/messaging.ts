export type SyncStatus = 'idle' | 'running' | 'error' | 'done'

export interface ProgressEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  fields: string[]
}

export interface StreamStats {
  stream: string
  records: number
  status: 'pending' | 'running' | 'complete' | 'error' | 'skip'
  error?: string
}

export interface SyncStats {
  started_at: number
  last_activity_at: number
  total_records: number
  streams: StreamStats[]
  phase: string
}

export interface OffscreenState {
  status: SyncStatus
  progress: ProgressEntry[]
  stats: SyncStats | null
}

export type Request =
  | { kind: 'content:dashboard_ready' }
  | { kind: 'panel:ensure_ready' }
  | { kind: 'offscreen:get_state' }
  | { kind: 'offscreen:start_sync'; api_key: string }
  | { kind: 'offscreen:stop_sync' }
  | { kind: 'offscreen:run_query'; sql: string }
  | { kind: 'offscreen:clear_db' }
  | { kind: 'offscreen:reset_state' }
  | { kind: 'offscreen:get_storage_info' }
  | { kind: 'offscreen:get_fetch_log' }

export type Broadcast =
  | { kind: 'status'; status: SyncStatus }
  | { kind: 'progress'; entry: ProgressEntry }
  | { kind: 'stats'; stats: SyncStats }

export type AnyMessage = Request | Broadcast

export async function send<T = unknown>(req: Request): Promise<T> {
  return (await chrome.runtime.sendMessage(req)) as T
}

export function broadcast(msg: Broadcast): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no listener — fine */
  })
}
