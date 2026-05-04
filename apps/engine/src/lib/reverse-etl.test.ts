import { describe, expect, it } from 'vitest'
import type { ConnectorResolver, ResolvedConnector } from './resolver.js'
import type { Destination, Source } from '@stripe/sync-protocol'
import { createEngine } from './engine.js'
import { createPostgresSource } from '@stripe/sync-source-postgres'
import { createStripeDestination } from '@stripe/sync-destination-stripe'

function makeResolver(source: Source, destination: Destination): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
    sources: () => new Map<string, ResolvedConnector<Source>>(),
    destinations: () => new Map<string, ResolvedConnector<Destination>>(),
  }
}

function queryResult<T extends Record<string, unknown>>(rows: T[]) {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  }
}

function stripeResponse(json: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('reverse ETL', () => {
  it('syncs Postgres customer rows into Stripe Customer upserts through pipeline_sync_batch', async () => {
    const rows = [
      {
        id: 'crm_123',
        email: 'jenny@example.com',
        name: 'Jenny Rosen',
        plan: 'enterprise',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    const stripeRequests: Array<{ url: string; init?: RequestInit }> = []

    const source = createPostgresSource({
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createPool: () => ({
        async query(text: string, values?: unknown[]) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'email', data_type: 'text', is_nullable: 'YES' },
              { column_name: 'name', data_type: 'text', is_nullable: 'YES' },
              { column_name: 'plan', data_type: 'text', is_nullable: 'YES' },
              { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
            ])
          }

          const cursor = values && values.length > 1 ? String(values[0]) : undefined
          return queryResult(rows.filter((row) => !cursor || row.updated_at > cursor))
        },
        async end() {},
      }),
    })

    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        stripeRequests.push({ url: String(url), init })
        if (String(url).includes('/v1/customers/search')) {
          return stripeResponse({ object: 'search_result', data: [] })
        }
        return stripeResponse({
          id: 'cus_123',
          object: 'customer',
          metadata: { crm_customer_id: 'crm_123' },
        })
      },
    })

    const engine = await createEngine(makeResolver(source, destination))
    const result = await engine.pipeline_sync_batch(
      {
        source: {
          type: 'postgres',
          postgres: {
            url: 'postgres://example',
            table: 'crm_customers',
            primary_key: ['id'],
            cursor_field: 'updated_at',
            page_size: 100,
          },
        },
        destination: {
          type: 'stripe',
          stripe: {
            api_key: 'sk_test_123',
            api_version: '2026-03-25.dahlia',
            base_url: 'https://stripe.test',
            object: 'customer',
            mode: 'upsert',
            allow_create: true,
            identity: {
              external_id_field: 'id',
              metadata_key: 'crm_customer_id',
            },
            fields: {
              email: 'email',
              name: 'name',
              'metadata[plan]': 'plan',
            },
          },
        },
        streams: [{ name: 'crm_customers', sync_mode: 'incremental' }],
      },
      { run_id: 'run_reverse_etl_test' }
    )

    expect(result.status).toBe('started')
    expect(result.run_progress.derived.total_record_count).toBe(1)
    expect(result.run_progress.derived.total_state_count).toBe(1)
    expect(result.ending_state?.source.streams.crm_customers).toEqual({
      cursor: '2026-01-01T00:00:00.000Z',
      primary_key: ['crm_123'],
    })
    expect(stripeRequests.map((request) => request.url)).toEqual([
      'https://stripe.test/v1/customers/search?query=metadata%5B%27crm_customer_id%27%5D%3A%27crm_123%27&limit=2',
      'https://stripe.test/v1/customers',
    ])
    expect(stripeRequests[1]!.init?.body).toBe(
      'email=jenny%40example.com&name=Jenny%20Rosen&metadata%5Bplan%5D=enterprise&metadata%5Bcrm_customer_id%5D=crm_123&metadata%5Breverse_etl_source%5D=sync-engine'
    )
  })
})
