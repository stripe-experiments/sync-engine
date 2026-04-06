export type StripeListServerOptions = {
  port?: number
  host?: string
  apiVersion?: string
  openApiSpecPath?: string
  postgresUrl?: string
  schema?: string
  /** Unix timestamp for the fake account's `created` field. Controls backfill range start. */
  accountCreated?: number
  fetchImpl?: typeof globalThis.fetch
}

export type StripeListServer = {
  host: string
  port: number
  url: string
  postgresUrl: string
  postgresMode: 'docker' | 'external'
  close: () => Promise<void>
}

export type PageResult = { data: Record<string, unknown>[]; hasMore: boolean; lastId?: string }

export type V1PageQuery = {
  limit: number
  afterId?: string
  beforeId?: string
  createdGt?: number
  createdGte?: number
  createdLt?: number
  createdLte?: number
}

export type V2PageQuery = {
  limit: number
  afterId?: string
}
