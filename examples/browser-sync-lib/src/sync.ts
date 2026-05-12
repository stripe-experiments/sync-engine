import { createEngine, createConnectorResolver } from '@stripe/sync-engine/lib'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres/pglite'

export interface SyncOptions {
  apiKey: string
  websocket?: boolean
  schema?: string
  batchSize?: number
  databaseUrl?: string
  onMessage?: (msg: unknown) => void
  signal?: AbortSignal
}

export async function startSync({
  apiKey,
  websocket = true,
  schema = 'stripe',
  batchSize = 50,
  databaseUrl = 'memory://',
  onMessage,
  signal,
}: SyncOptions) {
  const resolver = await createConnectorResolver({
    sources: { stripe: sourceStripe },
    destinations: { postgres: destinationPostgres },
  })

  const engine = createEngine(resolver)

  const pipeline = {
    source: {
      type: 'stripe' as const,
      stripe: { api_key: apiKey, websocket },
    },
    destination: {
      type: 'postgres' as const,
      postgres: { url: databaseUrl, schema, batch_size: batchSize },
    },
  }

  for await (const msg of engine.pipeline_setup(pipeline)) {
    onMessage?.(msg)
    if (signal?.aborted) return
  }

  for await (const msg of engine.pipeline_sync(pipeline)) {
    onMessage?.(msg)
    if (signal?.aborted) return
  }
}
