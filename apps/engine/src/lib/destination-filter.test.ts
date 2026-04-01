import { describe, expect, it } from 'vitest'
import type {
  Destination,
  ConfiguredCatalog,
  DestinationInput,
} from '@stripe/sync-protocol'
import { catalogFilter, composeDestination } from './destination-filter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

function makeCatalog(
  streams: Array<{
    name: string
    fields?: string[]
    json_schema?: Record<string, unknown>
  }>
): ConfiguredCatalog {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: [['id']], json_schema: s.json_schema },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'append' as const,
      fields: s.fields,
    })),
  }
}

function capturingDestination() {
  const captured: { setup?: ConfiguredCatalog; write?: ConfiguredCatalog } = {}

  const dest: Destination = {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' }),
    async setup({ catalog }) {
      captured.setup = catalog
    },
    async *write({ catalog }, $stdin) {
      captured.write = catalog
      for await (const msg of $stdin) {
        if (msg.type === 'state') yield msg
      }
    },
  }

  return { dest, captured }
}

function props(catalog: ConfiguredCatalog, index = 0): Record<string, unknown> {
  return catalog.streams[index]!.stream.json_schema!.properties as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// catalogFilter()
// ---------------------------------------------------------------------------

describe('catalogFilter()', () => {
  it('prunes json_schema.properties to selected fields plus primary key', () => {
    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['name', 'email'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
    ])

    const filtered = catalogFilter(catalog)
    expect(Object.keys(props(filtered))).toEqual(['id', 'name', 'email'])
  })

  it('passes catalog through unchanged when no fields configured', () => {
    const catalog = makeCatalog([
      {
        name: 'products',
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            active: { type: 'boolean' },
          },
        },
      },
    ])

    const filtered = catalogFilter(catalog)
    expect(Object.keys(props(filtered))).toEqual(['id', 'name', 'active'])
  })

  it('passes stream through unchanged when json_schema is absent', () => {
    const catalog = makeCatalog([{ name: 'events', fields: ['id', 'type'] }])
    const filtered = catalogFilter(catalog)
    expect(filtered.streams[0]!.stream.json_schema).toBeUndefined()
  })

  it('filters only streams that have fields set', () => {
    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['email'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
      {
        name: 'products',
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    ])

    const filtered = catalogFilter(catalog)
    expect(Object.keys(props(filtered, 0))).toEqual(['id', 'email'])
    expect(Object.keys(props(filtered, 1))).toEqual(['id', 'name'])
  })
})

// ---------------------------------------------------------------------------
// composeDestination()
// ---------------------------------------------------------------------------

describe('composeDestination()', () => {
  it('applies catalogFilter to setup()', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = composeDestination(dest, catalogFilter)

    const catalog = makeCatalog([
      {
        name: 'invoices',
        fields: ['amount', 'currency'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            amount: { type: 'integer' },
            currency: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    ])

    await wrapped.setup!({ config: {}, catalog })
    expect(Object.keys(props(captured.setup!))).toEqual(['id', 'amount', 'currency'])
  })

  it('applies catalogFilter to write()', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = composeDestination(dest, catalogFilter)

    const catalog = makeCatalog([
      {
        name: 'invoices',
        fields: ['amount', 'currency'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            amount: { type: 'integer' },
            currency: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    ])

    const input: DestinationInput[] = [{ type: 'state', stream: 'invoices', data: { cursor: '1' } }]
    await drain(wrapped.write({ config: {}, catalog }, toAsync(input)))
    expect(Object.keys(props(captured.write!))).toEqual(['id', 'amount', 'currency'])
  })

  it('applies multiple middlewares left-to-right', async () => {
    const { dest, captured } = capturingDestination()

    const addFoo: (catalog: ConfiguredCatalog) => ConfiguredCatalog = (catalog) => ({
      ...catalog,
      streams: catalog.streams.map((cs) => ({
        ...cs,
        stream: {
          ...cs.stream,
          json_schema: cs.stream.json_schema
            ? {
                ...cs.stream.json_schema,
                properties: {
                  ...(cs.stream.json_schema.properties as Record<string, unknown>),
                  foo: { type: 'string' },
                },
              }
            : cs.stream.json_schema,
        },
      })),
    })

    const wrapped = composeDestination(dest, addFoo, catalogFilter)

    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['email', 'foo'],
        json_schema: {
          type: 'object',
          properties: { id: { type: 'string' }, email: { type: 'string' } },
        },
      },
    ])

    await wrapped.setup!({ config: {}, catalog })
    // addFoo adds 'foo', then catalogFilter keeps only fields=['email','foo'] + pk
    expect(Object.keys(props(captured.setup!))).toEqual(['id', 'email', 'foo'])
  })

  it('omits setup when underlying destination has no setup', () => {
    const dest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
    }

    const wrapped = composeDestination(dest, catalogFilter)
    expect(wrapped.setup).toBeUndefined()
  })

  it('delegates spec() unchanged', () => {
    const spec = { config: { type: 'object', properties: { url: { type: 'string' } } } }
    const dest: Destination = {
      spec: () => spec,
      check: async () => ({ status: 'succeeded' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
    }

    const wrapped = composeDestination(dest, catalogFilter)
    expect(wrapped.spec()).toBe(spec)
  })

  it('delegates check() unchanged', async () => {
    const dest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'failed', message: 'bad creds' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
    }

    const wrapped = composeDestination(dest, catalogFilter)
    expect(await wrapped.check({ config: {} })).toEqual({ status: 'failed', message: 'bad creds' })
  })

  it('delegates teardown() unchanged', async () => {
    let teardownCalled = false
    const dest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
      async teardown() {
        teardownCalled = true
      },
    }

    const wrapped = composeDestination(dest, catalogFilter)
    await wrapped.teardown!({ config: {} })
    expect(teardownCalled).toBe(true)
  })
})
