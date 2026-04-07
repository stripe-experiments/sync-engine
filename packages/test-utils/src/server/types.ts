export type SeedCustomersForListServerOptions = {
  /**
   * stripe-mock base URL (no trailing slash). Used to POST /v1/customers for a template object.
   * @default http://localhost:12111
   */
  stripeMockUrl?: string
  /** Authorization bearer value for stripe-mock. @default sk_test_fake */
  stripeMockApiKey?: string
  /** Number of customer rows to insert. */
  count: number
  /**
   * Synthetic ids are `${idPrefix}_${index padded with zeros}`.
   * @default cus_test
   */
  idPrefix?: string
  /** Zero-pad width for the numeric suffix. @default 5 */
  idPadLength?: number
  /** Spread `created` across this unix range (seconds). */
  createdRange: { startUnix: number; endUnix: number }
  /** upsertObjects batch size. @default 1000 */
  batchSize?: number
}

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
  /** When set, seed `customers` in the list-server DB after schema ensure (stripe-mock template + upserts). */
  seedCustomers?: SeedCustomersForListServerOptions
}

export type StripeListServer = {
  host: string
  port: number
  url: string
  postgresUrl: string
  postgresMode: 'docker' | 'external'
  close: () => Promise<void>
  /** Present when `seedCustomers` was passed; ordered synthetic ids used for assertions. */
  seededCustomerIds?: string[]
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
