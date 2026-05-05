import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSchemas } from './createSchemas.js'
import type { ConnectorResolver } from '@stripe/sync-engine'

const postgresLikeConfigSchema = {
  anyOf: [
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        table: { type: 'string' },
        cursor_field: { type: 'string' },
        primary_key: { type: 'array', items: { type: 'string' } },
      },
      required: ['url', 'table', 'cursor_field'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        query: { type: 'string' },
        stream: { type: 'string' },
        cursor_field: { type: 'string' },
      },
      required: ['url', 'query', 'stream', 'cursor_field'],
      additionalProperties: false,
    },
  ],
} satisfies Record<string, unknown>

function resolverWithUnionConfig(): ConnectorResolver {
  return {
    async resolveSource() {
      throw new Error('not used')
    },
    async resolveDestination() {
      throw new Error('not used')
    },
    sources() {
      return new Map([
        [
          'postgres',
          {
            connector: {} as never,
            configSchema: z.any(),
            rawConfigJsonSchema: postgresLikeConfigSchema,
          },
        ],
      ])
    },
    destinations() {
      return new Map([
        [
          'stripe',
          {
            connector: {} as never,
            configSchema: z.any(),
            rawConfigJsonSchema: {
              type: 'object',
              properties: { api_key: { type: 'string' } },
              required: ['api_key'],
              additionalProperties: false,
            },
          },
        ],
      ])
    },
  }
}

describe('createSchemas', () => {
  it('preserves connector payload fields for anyOf config schemas', () => {
    const { CreatePipeline } = createSchemas(resolverWithUnionConfig())

    const parsed = CreatePipeline.parse({
      id: 'my_pipe',
      source: {
        type: 'postgres',
        postgres: {
          url: 'postgres://localhost/db',
          table: 'crm_customers',
          cursor_field: 'updated_at',
          primary_key: ['id'],
        },
      },
      destination: { type: 'stripe', stripe: { api_key: 'sk_test_123' } },
      streams: [{ name: 'customer', sync_mode: 'incremental' }],
    })

    expect(parsed.source.postgres).toEqual({
      url: 'postgres://localhost/db',
      table: 'crm_customers',
      cursor_field: 'updated_at',
      primary_key: ['id'],
    })
  })
})
