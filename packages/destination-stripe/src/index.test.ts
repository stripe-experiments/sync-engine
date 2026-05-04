import { describe, expect, it } from 'vitest'
import type { ConfiguredCatalog, Message } from '@stripe/sync-protocol'
import { createStripeDestination } from './index.js'
import { configSchema } from './spec.js'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

function response(json: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function inputMessages(): Message[] {
  return [
    {
      type: 'record',
      record: {
        stream: 'crm_customers',
        data: {
          id: 'crm_123',
          email: 'jenny@example.com',
          name: 'Jenny Rosen',
          plan: 'enterprise',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        emitted_at: '2026-05-03T00:00:00.000Z',
      },
    },
    {
      type: 'source_state',
      source_state: {
        state_type: 'stream',
        stream: 'crm_customers',
        data: { cursor: '2026-01-01T00:00:00.000Z', primary_key: ['crm_123'] },
      },
    },
  ]
}

const config = configSchema.parse({
  api_key: 'sk_test_123',
  api_version: BUNDLED_API_VERSION,
  base_url: 'https://stripe.test',
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
})

const catalog: ConfiguredCatalog = {
  streams: [
    {
      stream: {
        name: 'crm_customers',
        primary_key: [['id']],
        newer_than_field: 'updated_at',
      },
      sync_mode: 'incremental',
      destination_sync_mode: 'append',
    },
  ],
}

describe('destination-stripe', () => {
  it('creates a customer and passes source_state after the write succeeds', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).includes('/v1/customers/search')) {
          return response({ object: 'search_result', data: [] })
        }
        return response({
          id: 'cus_123',
          object: 'customer',
          metadata: { crm_customer_id: 'crm_123' },
        })
      },
    })

    const messages = await collect(destination.write({ config, catalog }, inputMessages()))

    expect(messages.map((message) => message.type)).toEqual(['record', 'source_state'])
    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toBe('https://stripe.test/v1/customers')
    expect(requests[1]!.init?.method).toBe('POST')
    expect((requests[1]!.init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^reverse-etl-[a-f0-9]{64}$/
    )
    expect(requests[1]!.init?.body).toBe(
      'email=jenny%40example.com&name=Jenny%20Rosen&metadata%5Bplan%5D=enterprise&metadata%5Bcrm_customer_id%5D=crm_123&metadata%5Breverse_etl_source%5D=sync-engine'
    )
  })

  it('updates by explicit Stripe Customer ID without searching', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response({ id: 'cus_existing', object: 'customer' })
      },
    })

    const messages = inputMessages()
    const record = messages[0]!
    if (record.type === 'record') {
      record.record.data.stripe_customer_id = 'cus_existing'
    }
    const updateConfig = configSchema.parse({
      ...config,
      identity: {
        ...config.identity,
        stripe_id_field: 'stripe_customer_id',
      },
    })

    await collect(destination.write({ config: updateConfig, catalog }, messages))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://stripe.test/v1/customers/cus_existing')
  })

  it('withholds source_state after a failed Stripe write', async () => {
    const destination = createStripeDestination({
      sleep: async () => {},
      fetch: async (url) => {
        if (String(url).includes('/v1/customers/search')) {
          return response({ object: 'search_result', data: [] })
        }
        return response({ error: { message: 'invalid email' } }, { status: 400 })
      },
    })

    const messages = await collect(destination.write({ config, catalog }, inputMessages()))

    expect(messages).toEqual([
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error: 'invalid email',
        },
      },
    ])
  })

  it('rejects unsupported Stripe objects without attempting a write', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const destination = createStripeDestination({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return response({ id: 'unexpected' })
      },
    })
    const invoiceConfig = configSchema.parse({ ...config, object: 'invoice' })

    const messages = await collect(
      destination.write({ config: invoiceConfig, catalog }, inputMessages())
    )

    expect(requests).toEqual([])
    expect(messages).toEqual([
      {
        type: 'stream_status',
        stream_status: {
          stream: 'crm_customers',
          status: 'error',
          error:
            'destination-stripe currently supports writing only Stripe Customers; object "invoice" is not supported',
        },
      },
    ])
  })
})
