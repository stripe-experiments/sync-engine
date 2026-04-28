import { describe, expect, it } from 'vitest'
import { SpecParser } from '../specParser'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'
import type { OpenApiSpec } from '../../types'

describe('SpecParser', () => {
  it('parses resources into deterministic singular tables and column types', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_session', 'customer', 'radar_early_fraud_warning'],
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_session',
      'customer',
      'radar_early_fraud_warning',
    ])

    const customer = parsed.tables.find((table) => table.tableName === 'customer')
    expect(customer?.columns).toEqual([
      { name: 'created', type: 'bigint', nullable: true },
      { name: 'deleted', type: 'boolean', nullable: true },
      { name: 'object', type: 'text', nullable: true },
    ])

    const checkoutSessions = parsed.tables.find((table) => table.tableName === 'checkout_session')
    expect(checkoutSessions?.columns).toContainEqual({
      name: 'amount_total',
      type: 'bigint',
      nullable: true,
    })
  })

  it('does not synthesize compatibility tables when schemas are absent', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: { schemas: {} },
      },
      { allowedTables: ['entitlements_active_entitlement', 'subscription_item'] }
    )

    expect(parsed.tables).toEqual([])
  })

  it('is deterministic regardless of schema key order', () => {
    const parser = new SpecParser()
    const normal = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['customer', 'plan', 'price'],
    })

    const reversedSchemas = Object.fromEntries(
      Object.entries(minimalStripeOpenApiSpec.components?.schemas ?? {}).reverse()
    )
    const reversed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: reversedSchemas,
        },
      },
      { allowedTables: ['customer', 'plan', 'price'] }
    )

    expect(reversed).toEqual(normal)
  })

  it('marks expandable references from x-expansionResources metadata', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            charge: {
              'x-resourceId': 'charge',
              type: 'object',
              properties: {
                id: { type: 'string' },
                customer: {
                  anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/customer' }],
                  'x-expansionResources': {
                    oneOf: [{ $ref: '#/components/schemas/customer' }],
                  },
                },
              },
            },
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['charge'] }
    )

    const charge = parsed.tables.find((table) => table.tableName === 'charge')
    expect(charge?.columns).toContainEqual({
      name: 'customer',
      type: 'text',
      nullable: true,
      expandableReference: true,
      expansionResourceIds: ['customer'],
    })
  })

  describe('discoverListableResourceIds', () => {
    it('discovers resource ids from list endpoints in paths', () => {
      const parser = new SpecParser()
      const ids = parser.discoverListableResourceIds(minimalStripeOpenApiSpec)

      expect(ids).toEqual(
        new Set([
          'customer',
          'plan',
          'price',
          'product',
          'subscription_item',
          'checkout.session',
          'radar.early_fraud_warning',
          'entitlements.active_entitlement',
          'entitlements.feature',
          'v2.core.account',
          'v2.core.event_destination',
        ])
      )
      expect(ids).not.toContain('recipient')
      expect(ids).not.toContain('exchange_rate')
      expect(ids).not.toContain('deprecated_widget')
    })

    it('optionally includes nested list endpoints', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: {
          ...minimalStripeOpenApiSpec.paths,
          '/v1/accounts/{account}/persons': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object' as const,
                        properties: {
                          object: {
                            type: 'string' as const,
                            enum: ['list'],
                          },
                          data: {
                            type: 'array' as const,
                            items: {
                              $ref: '#/components/schemas/person',
                            },
                          },
                          has_more: {
                            type: 'boolean' as const,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          ...minimalStripeOpenApiSpec.components,
          schemas: {
            ...minimalStripeOpenApiSpec.components.schemas,
            person: {
              'x-resourceId': 'person',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      }

      const ids = parser.discoverListableResourceIds(spec, {
        includeNested: true,
      })
      expect(ids).toContain('person')
    })

    it('excludes paths present in the generated global deprecated set', () => {
      const parser = new SpecParser()
      const ids = parser.discoverListableResourceIds(minimalStripeOpenApiSpec)
      expect(ids).not.toContain('recipient')
      expect(ids).toContain('customer')
    })

    it('returns empty set when spec has no paths', () => {
      const parser = new SpecParser()
      const specWithoutPaths: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: undefined,
      }
      expect(parser.discoverListableResourceIds(specWithoutPaths)).toEqual(new Set())
    })

    it('ignores non-list GET endpoints', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        openapi: '3.0.0',
        paths: {
          '/v1/customers/{customer}': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        },
      }
      expect(parser.discoverListableResourceIds(spec)).toEqual(new Set())
    })
  })

  describe('discoverWebhookUpdatableResourceIds', () => {
    it('discovers resource ids that have create/update/delete webhook events', () => {
      const parser = new SpecParser()
      const ids = parser.discoverWebhookUpdatableResourceIds(minimalStripeOpenApiSpec)

      expect(ids).toContain('customer')
      expect(ids).toContain('plan')
      expect(ids).toContain('price')
      expect(ids).toContain('product')
      expect(ids).toContain('subscription_item')
      expect(ids).toContain('checkout.session')
      expect(ids).toContain('radar.early_fraud_warning')
      expect(ids).toContain('entitlements.active_entitlement')
      expect(ids).toContain('entitlements.feature')
      expect(ids).toContain('v2.core.account')
      expect(ids).toContain('v2.core.event_destination')
    })

    it('excludes resources that have no create/update/delete webhook events', () => {
      const parser = new SpecParser()
      const ids = parser.discoverWebhookUpdatableResourceIds(minimalStripeOpenApiSpec)

      // recipient, exchange_rate, deprecated_widget have no webhook event schemas
      expect(ids).not.toContain('recipient')
      expect(ids).not.toContain('exchange_rate')
      expect(ids).not.toContain('deprecated_widget')
    })

    it('ignores webhook events that are not create/update/delete', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            ...minimalStripeOpenApiSpec.components?.schemas,
            customer_no_crud_events: {
              'x-resourceId': 'customer_no_crud_events',
              type: 'object',
              properties: { id: { type: 'string' } },
            },
            'customer_no_crud_events.authorized': {
              'x-stripeEvent': { type: 'customer_no_crud_events.authorized' },
              type: 'object',
              properties: {
                object: { $ref: '#/components/schemas/customer_no_crud_events' },
              },
            },
          },
        },
      }
      const ids = parser.discoverWebhookUpdatableResourceIds(spec)
      expect(ids).not.toContain('customer_no_crud_events')
    })

    it('returns empty set when spec has no schemas', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        components: { schemas: {} },
      }
      expect(parser.discoverWebhookUpdatableResourceIds(spec)).toEqual(new Set())
    })
  })

  describe('default projection', () => {
    it('projects every schema with x-resourceId when allowedTables is omitted', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)

      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toEqual([
        'checkout_session',
        'customer',
        'deprecated_widget',
        'entitlements_active_entitlement',
        'entitlements_feature',
        'exchange_rate',
        'plan',
        'price',
        'product',
        'radar_early_fraud_warning',
        'recipient',
        'subscription_item',
        'v2_core_account',
        'v2_core_event_destination',
      ])
    })

    it('includes nested listables when they appear in the OpenAPI paths', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: {
          ...minimalStripeOpenApiSpec.paths,
          '/v1/accounts/{account}/persons': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object' as const,
                        properties: {
                          object: {
                            type: 'string' as const,
                            enum: ['list'],
                          },
                          data: {
                            type: 'array' as const,
                            items: {
                              $ref: '#/components/schemas/person',
                            },
                          },
                          has_more: {
                            type: 'boolean' as const,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          ...minimalStripeOpenApiSpec.components,
          schemas: {
            ...minimalStripeOpenApiSpec.components.schemas,
            person: {
              'x-resourceId': 'person',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            'person.created': {
              'x-stripeEvent': { type: 'person.created' },
              type: 'object' as const,
              properties: { object: { $ref: '#/components/schemas/person' } },
            },
          },
        },
      }

      const parsed = parser.parse(spec)
      const tableNames = parsed.tables.map((table) => table.tableName)
      expect(tableNames).toContain('person')
    })

    it('does not use path deprecation to filter pure schema projection', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)
      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toContain('deprecated_widget')
      expect(tableNames).toContain('exchange_rate')
      expect(tableNames).toContain('customer')
    })

    it('uses allowedTables as an explicit projection filter', () => {
      const parser = new SpecParser()
      const specWithLimitedPaths: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: {
          '/v1/customers': minimalStripeOpenApiSpec.paths!['/v1/customers'],
          '/v1/products': minimalStripeOpenApiSpec.paths!['/v1/products'],
        },
      }
      const parsed = parser.parse(specWithLimitedPaths)

      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toContain('plan')
      expect(tableNames).toContain('subscription_item')

      const filtered = parser.parse(specWithLimitedPaths, { allowedTables: ['customer', 'product'] })
      expect(filtered.tables.map((t) => t.tableName)).toEqual(['customer', 'product'])
    })

    it('does not use webhook event coverage to filter pure schema projection', () => {
      const parser = new SpecParser()
      // Build a spec where 'product' has a list endpoint but its webhook events are removed
      const schemasWithoutProductEvents = Object.fromEntries(
        Object.entries(minimalStripeOpenApiSpec.components?.schemas ?? {}).filter(
          ([k]) => !k.startsWith('product.')
        )
      )
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        components: { schemas: schemasWithoutProductEvents },
      }
      const parsed = parser.parse(spec)
      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toContain('product')
      expect(tableNames).toContain('customer')
    })

    it('normalizes namespaced x-resourceId values during discovery', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)

      const earlyFraud = parsed.tables.find((t) => t.tableName === 'radar_early_fraud_warning')
      expect(earlyFraud).toBeDefined()
      expect(earlyFraud?.resourceId).toBe('radar.early_fraud_warning')

      const checkout = parsed.tables.find((t) => t.tableName === 'checkout_session')
      expect(checkout).toBeDefined()
      expect(checkout?.resourceId).toBe('checkout.session')
    })
  })
})
