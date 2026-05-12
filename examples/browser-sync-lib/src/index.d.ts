export interface SyncOptions {
  apiKey: string
  websocket?: boolean
  schema?: string
  batchSize?: number
  databaseUrl?: string
  onMessage?: (msg: unknown) => void
  signal?: AbortSignal
}

export declare function startSync(options: SyncOptions): Promise<void>
