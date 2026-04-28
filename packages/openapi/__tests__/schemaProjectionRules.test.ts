import { describe, expect, it } from 'vitest'
import { parsedTableToJsonSchema } from '../jsonSchemaConverter'
import { resolveTableName } from '../listFnResolver'
import { SpecParser } from '../specParser'
import type { OpenApiSpec } from '../types'

const schemaRulesSpec = {
  openapi: '3.0.0',
  info: { version: '2026-03-25' },
  paths: {},
  components: {
    schemas: {
      subscription: {
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.subscription.title
        title: 'Subscription',
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.subscription.type
        type: 'object',
        required: ['created', 'customer', 'items', 'livemode', 'metadata', 'object', 'start_date', 'status'],
        properties: {
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.application_fee_percent
          application_fee_percent: {
            type: 'number',
            description:
              "A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice total that will be transferred to the application owner's Stripe account.",
            nullable: true,
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.created
          created: {
            type: 'integer',
            description:
              'Time at which the object was created. Measured in seconds since the Unix epoch.',
            format: 'unix-time',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.customer
          customer: {
            description: 'ID of the customer who owns the subscription.',
            anyOf: [
              { maxLength: 5000, type: 'string' },
              { $ref: '#/components/schemas/customer' },
              { $ref: '#/components/schemas/deleted_customer' },
            ],
            'x-expansionResources': {
              oneOf: [
                { $ref: '#/components/schemas/customer' },
                { $ref: '#/components/schemas/deleted_customer' },
              ],
            },
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.items
          items: {
            title: 'SubscriptionItemList',
            required: ['data', 'has_more', 'object', 'url'],
            type: 'object',
            properties: {
              data: {
                type: 'array',
                description: 'Details about each object.',
                items: { $ref: '#/components/schemas/subscription_item' },
              },
              has_more: {
                type: 'boolean',
                description:
                  'True if this list has another page of items after this one that can be fetched.',
              },
              object: {
                type: 'string',
                description:
                  "String representing the object's type. Objects of the same type share the same value. Always has the value `list`.",
                enum: ['list'],
              },
              url: {
                maxLength: 5000,
                type: 'string',
                description: 'The URL where this list can be accessed.',
              },
            },
            description: 'List of subscription items, each with an attached price.',
            'x-expandableFields': ['data'],
            'x-stripeMostCommon': ['data', 'has_more', 'object', 'url'],
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.livemode
          livemode: {
            type: 'boolean',
            description:
              'If the object exists in live mode, the value is `true`. If the object exists in test mode, the value is `false`.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.metadata
          metadata: {
            type: 'object',
            additionalProperties: { maxLength: 500, type: 'string' },
            description:
              'Set of [key-value pairs](https://docs.stripe.com/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.start_date
          start_date: {
            type: 'integer',
            description:
              'Date when the subscription was first created. The date might differ from the `created` date due to backdating.',
            format: 'unix-time',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.status
          status: {
            type: 'string',
            description:
              "Possible values are `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, or `paused`. \n\nFor `collection_method=charge_automatically` a subscription moves into `incomplete` if the initial payment attempt fails. A subscription in this status can only have metadata and default_source updated. Once the first invoice is paid, the subscription moves into an `active` status. If the first invoice is not paid within 23 hours, the subscription transitions to `incomplete_expired`. This is a terminal status, the open invoice will be voided and no further invoices will be generated. \n\nA subscription that is currently in a trial period is `trialing` and moves to `active` when the trial period is over. \n\nA subscription can only enter a `paused` status [when a trial ends without a payment method](https://docs.stripe.com/billing/subscriptions/trials#create-free-trials-without-payment). A `paused` subscription doesn't generate invoices and can be resumed after your customer adds their payment method. The `paused` status is different from [pausing collection](https://docs.stripe.com/billing/subscriptions/pause-payment), which still generates invoices and leaves the subscription's status unchanged. \n\nIf subscription `collection_method=charge_automatically`, it becomes `past_due` when payment is required but cannot be paid (due to failed payment or awaiting additional user actions). Once Stripe has exhausted all payment retry attempts, the subscription will become `canceled` or `unpaid` (depending on your subscriptions settings). \n\nIf subscription `collection_method=send_invoice` it becomes `past_due` when its invoice is not paid by the due date, and `canceled` or `unpaid` if it is still not paid by an additional deadline after that. Note that when a subscription has a status of `unpaid`, no subsequent invoices will be attempted (invoices will be created, but then immediately automatically closed). After receiving updated payment information from a customer, you may choose to reopen and pay their closed invoices.",
            enum: [
              'active',
              'canceled',
              'incomplete',
              'incomplete_expired',
              'past_due',
              'paused',
              'trialing',
              'unpaid',
            ],
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription.properties.object
          object: {
            type: 'string',
            description:
              "String representing the object's type. Objects of the same type share the same value.",
            enum: ['subscription'],
          },
        },
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.subscription.x-resourceId
        'x-resourceId': 'subscription',
      },
      subscription_item: {
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.subscription_item.title
        title: 'SubscriptionItem',
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.subscription_item.type
        type: 'object',
        required: ['created', 'metadata', 'object', 'quantity', 'subscription'],
        properties: {
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription_item.properties.created
          created: {
            type: 'integer',
            description:
              'Time at which the object was created. Measured in seconds since the Unix epoch.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription_item.properties.id
          id: {
            maxLength: 5000,
            type: 'string',
            description: 'Unique identifier for the object.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription_item.properties.metadata
          metadata: {
            type: 'object',
            additionalProperties: { maxLength: 500, type: 'string' },
            description:
              'Set of [key-value pairs](https://docs.stripe.com/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription_item.properties.object
          object: {
            type: 'string',
            description:
              "String representing the object's type. Objects of the same type share the same value.",
            enum: ['subscription_item'],
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription_item.properties.quantity
          quantity: {
            type: 'integer',
            description:
              'The [quantity](https://docs.stripe.com/subscriptions/quantities) of the plan to which the customer should be subscribed.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.subscription_item.properties.subscription
          subscription: {
            maxLength: 5000,
            type: 'string',
            description: 'The `subscription` this `subscription_item` belongs to.',
          },
        },
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.subscription_item.x-resourceId
        'x-resourceId': 'subscription_item',
      },
      customer: {
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.customer.title
        title: 'Customer',
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.customer.type
        type: 'object',
        properties: {
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.customer.properties.id
          id: {
            maxLength: 5000,
            type: 'string',
            description: 'Unique identifier for the object.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.customer.properties.object
          object: {
            type: 'string',
            description:
              "String representing the object's type. Objects of the same type share the same value.",
            enum: ['customer'],
          },
        },
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.customer.x-resourceId
        'x-resourceId': 'customer',
      },
      deleted_customer: {
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.deleted_customer.title
        title: 'DeletedCustomer',
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.deleted_customer.type
        type: 'object',
        properties: {
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.deleted_customer.properties.deleted
          deleted: {
            type: 'boolean',
            description: 'Always true for a deleted object',
            enum: [true],
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.deleted_customer.properties.id
          id: {
            maxLength: 5000,
            type: 'string',
            description: 'Unique identifier for the object.',
          },
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas.deleted_customer.properties.object
          object: {
            type: 'string',
            description:
              "String representing the object's type. Objects of the same type share the same value.",
            enum: ['customer'],
          },
        },
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas.deleted_customer.x-resourceId
        'x-resourceId': 'deleted_customer',
      },
      'v2.core.account': {
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas["v2.core.account"].title
        title: 'Account',
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas["v2.core.account"].type
        type: 'object',
        required: ['created'],
        properties: {
          // Copied from openapi spec version: 2026-03-25.dahlia.json:
          // components.schemas["v2.core.account"].properties.created
          created: {
            type: 'string',
            description:
              'Time at which the object was created. Represented as a RFC 3339 date & time UTC value in millisecond precision, for example: 2022-09-18T13:22:18.123Z.',
            format: 'date-time',
          },
        },
        // Copied from openapi spec version: 2026-03-25.dahlia.json:
        // components.schemas["v2.core.account"].x-resourceId
        'x-resourceId': 'v2.core.account',
      },
    },
  },
} as unknown as OpenApiSpec

const parser = new SpecParser()

// Keep parser setup inline in each numbered test so the fixture shape and selected tables are visible at the assertion site.
describe('schema projection', () => {
  it('1: each Stripe resource maps to one canonical table from x-resourceId', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })

    expect(parsed.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: 'subscription',
          resourceId: 'subscription',
          sourceSchemaName: 'subscription',
        }),
        expect.objectContaining({
          tableName: 'subscription_item',
          resourceId: 'subscription_item',
          sourceSchemaName: 'subscription_item',
        }),
      ])
    )
  })

  it('2: table names are singular snake_case with namespace dots converted to underscores', () => {
    expect(resolveTableName('customer', {})).toBe('customer')
    expect(resolveTableName('subscription_item', {})).toBe('subscription_item')
    expect(resolveTableName('v2.core.account', {})).toBe('v2_core_account')
  })

  it('3: one row represents one Stripe object with id as the row identity', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(schema.type).toBe('object')
    expect(props.id).toEqual({ type: 'string' })
    expect(schema.required).toContain('id')
  })

  it('4: column names mirror Stripe object field names', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()
    const names = subscription!.columns.map((column) => column.name)

    expect(names).toContain('customer')
    expect(names).not.toContain('customer_id')
  })

  it('5: expandable references are represented as id string columns in catalog schemas', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()
    expect(subscription!.columns).toContainEqual({
      name: 'customer',
      type: 'text',
      nullable: false,
      expandableReference: true,
      expansionResourceIds: ['customer', 'deleted_customer'],
    })

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.customer).toEqual({
      type: 'string',
      'x-expandable-reference': true,
      'x-expansion-resources': ['customer', 'deleted_customer'],
    })
  })

  it('6: polymorphic reference columns preserve logical join target metadata', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.customer).toMatchObject({
      'x-expandable-reference': true,
      'x-expansion-resources': ['customer', 'deleted_customer'],
    })
  })

  it('7: nested value data is kept inline by default', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.metadata).toEqual({ type: 'object' })
  })

  it('8: list envelope fields are removed from parent rows and represented by child resource tables', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    const subscriptionItem = parsed.tables.find((table) => table.tableName === 'subscription_item')

    expect(subscriptionItem).toBeDefined()
    expect(subscription?.columns.map((column) => column.name)).not.toContain('items')
  })

  it('9: strings and enums map to unconstrained string schema properties', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.status).toEqual({ type: 'string' })
  })

  it('10: booleans map to boolean schema properties', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.livemode).toEqual({ type: 'boolean' })
  })

  it('11: non-timestamp integer fields map to integer schema properties', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscriptionItem = parsed.tables.find((table) => table.tableName === 'subscription_item')
    expect(subscriptionItem).toBeDefined()

    const schema = parsedTableToJsonSchema(subscriptionItem!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.quantity).toEqual({ type: 'integer' })
  })

  it('12: OpenAPI number fields map to number schema properties', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.application_fee_percent).toEqual({ oneOf: [{ type: 'number' }, { type: 'null' }] })
  })

  it('13: v1 unix timestamps preserve integer shape; v2 date-time fields use date-time shape', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item', 'v2_core_account'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
        'v2.core.account': 'v2_core_account',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    const account = parsed.tables.find((table) => table.tableName === 'v2_core_account')
    expect(subscription).toBeDefined()
    expect(account).toBeDefined()

    expect(subscription!.columns).toContainEqual({
      name: 'start_date',
      type: 'bigint',
      nullable: false,
    })
    expect(account!.columns).toContainEqual({
      name: 'created',
      type: 'timestamptz',
      nullable: false,
    })
  })

  it('14: non-scalar values use structured schema properties unless another numbered behavior overrides them', () => {
    const parsed = parser.parse(schemaRulesSpec, {
      allowedTables: ['subscription', 'subscription_item'],
      resourceAliases: {
        subscription: 'subscription',
        subscription_item: 'subscription_item',
      },
    })
    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription).toBeDefined()

    const schema = parsedTableToJsonSchema(subscription!)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.metadata).toEqual({ type: 'object' })
  })
})
