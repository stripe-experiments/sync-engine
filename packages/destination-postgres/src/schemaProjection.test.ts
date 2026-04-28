import { describe, expect, it } from 'vitest'
import {
  jsonSchemaToColumns,
  buildCreateTableWithSchema,
  buildCreateTableDDL,
} from './schemaProjection.js'

const SAMPLE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    created: { type: 'integer' },
    deleted: { type: 'boolean' },
    metadata: { type: 'object' },
    expires_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'created'],
  'x-source-schema': 'customer',
}

const V2_DATE_TIME_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    created: { type: 'string', format: 'date-time' },
  },
}

const EXPANDABLE_REF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    customer: { type: 'object', 'x-expandable-reference': true },
  },
  required: ['id'],
}

const STRING_ENUM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['active', 'paused', 'cancelled'] },
  },
}

const LIST_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    items: {
      type: 'object',
      properties: {
        data: { type: 'array' },
        has_more: { type: 'boolean' },
        object: { type: 'string', enum: ['list'] },
        url: { type: 'string' },
      },
    },
  },
}

const CHILD_WITH_PARENT_REF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    subscription: { type: 'object', 'x-expandable-reference': true },
  },
}

describe('jsonSchemaToColumns', () => {
  it('maps JSON Schema types to pg column defs', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]))

    expect(byName.created.pgType).toBe('bigint')
    expect(byName.deleted.pgType).toBe('boolean')
    expect(byName.metadata.pgType).toBe('jsonb')
    expect(byName.expires_at.pgType).toBe('timestamptz')
  })

  it('skips the id column (generated separately)', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)
    expect(columns.find((c) => c.name === 'id')).toBeUndefined()
  })

  it('handles expandable references as text with CASE expression', () => {
    const columns = jsonSchemaToColumns(EXPANDABLE_REF_SCHEMA)
    const customerCol = columns.find((c) => c.name === 'customer')!
    expect(customerCol.pgType).toBe('text')
    expect(customerCol.expression).toContain('jsonb_typeof')
    expect(customerCol.expression).toContain("->>'id'")
  })

  it('skips _updated_at because it is a physical sync column, not generated', () => {
    const schema = {
      type: 'object',
      properties: { _updated_at: { type: 'integer' } },
    }
    expect(jsonSchemaToColumns(schema).find((c) => c.name === '_updated_at')).toBeUndefined()
  })
})

describe('buildCreateTableWithSchema', () => {
  it('produces generic DDL without _account_id when no options', () => {
    const stmts = buildCreateTableWithSchema('mydata', 'repos', SAMPLE_JSON_SCHEMA)

    // CREATE TABLE
    expect(stmts[0]).toContain('CREATE TABLE "mydata"."repos"')
    expect(stmts[0]).toContain('"_raw_data" jsonb NOT NULL')
    expect(stmts[0]).not.toContain('"_account_id"')
    expect(stmts[0]).toContain("GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED")

    // Generated columns in CREATE TABLE
    expect(stmts[0]).toContain('"created" bigint GENERATED ALWAYS AS')
    expect(stmts[0]).toContain('"metadata" jsonb GENERATED ALWAYS AS')

    // Single batched ALTER TABLE with all ADD COLUMN IF NOT EXISTS clauses
    const alterStmts = stmts.filter((s) => s.includes('ADD COLUMN IF NOT EXISTS'))
    expect(alterStmts.length).toBe(1)
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "created"')
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "deleted"')
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "metadata"')
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "expires_at"')

    // No FK constraint
    expect(stmts.some((s) => s.includes('FOREIGN KEY'))).toBe(false)

    // No indexes by default (no system_columns with index: true)
    expect(stmts.some((s) => s.includes('CREATE INDEX'))).toBe(false)

    // _updated_at stores the source-stamped value explicitly per row.
    expect(stmts[0]).toContain('"_synced_at" timestamptz NOT NULL DEFAULT now()')
    expect(stmts[0]).toContain('"_updated_at" timestamptz NOT NULL DEFAULT now()')
    expect(stmts.some((s) => s.includes('CREATE TRIGGER handle_updated_at'))).toBe(false)
    expect(stmts.some((s) => s.includes('set_updated_at()'))).toBe(false)
  })

  it('adds system columns and indexes when system_columns is provided', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA, {
      system_columns: [{ name: '_account_id', type: 'text', index: true }],
    })

    // Column present in CREATE TABLE
    expect(stmts[0]).toContain('"_account_id" text')
    // _account_id should be nullable (no NOT NULL)
    expect(stmts[0]).not.toMatch(/"_account_id" text NOT NULL/)

    // Index created
    expect(stmts.some((s) => s.includes('CREATE INDEX') && s.includes('"_account_id"'))).toBe(true)
  })

  it('handles multiple system columns with mixed index settings', () => {
    const stmts = buildCreateTableWithSchema('mydata', 'repos', SAMPLE_JSON_SCHEMA, {
      system_columns: [
        { name: '_account_id', type: 'text', index: true },
        { name: '_tenant_id', type: 'uuid', index: false },
      ],
    })

    expect(stmts[0]).toContain('"_account_id" text')
    expect(stmts[0]).toContain('"_tenant_id" uuid')

    // Only _account_id gets an index
    expect(stmts.some((s) => s.includes('CREATE INDEX') && s.includes('"_account_id"'))).toBe(true)
    expect(stmts.some((s) => s.includes('CREATE INDEX') && s.includes('"_tenant_id"'))).toBe(false)
  })

  it('handles expandable reference columns', () => {
    const stmts = buildCreateTableWithSchema('mydata', 'charges', EXPANDABLE_REF_SCHEMA)
    expect(stmts[0]).toContain('"customer" text GENERATED ALWAYS AS (CASE')
    expect(stmts[0]).toContain("WHEN jsonb_typeof(_raw_data->'customer') = 'object'")
  })

  it('generates composite primary key with _account_id when primary_key option is set', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA, {
      primary_key: [['id'], ['_account_id']],
    })

    // Both PK columns present as generated columns.
    // Since SAMPLE_JSON_SCHEMA has no enum for _account_id, it defaults to text.
    expect(stmts[0]).toContain(`"id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED`)
    expect(stmts[0]).toContain(`"_account_id" text GENERATED ALWAYS AS`)

    // Composite PRIMARY KEY
    expect(stmts[0]).toContain('PRIMARY KEY ("id", "_account_id")')

    // _account_id should NOT appear as a regular generated column from json_schema
    const alterStmts = stmts.filter((s) => s.includes('ADD COLUMN IF NOT EXISTS'))
    expect(alterStmts.every((s) => !s.includes('"_account_id"'))).toBe(true)
  })

  it('produces stable output across repeated calls', () => {
    const first = buildCreateTableWithSchema('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    const second = buildCreateTableWithSchema('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    expect(second).toEqual(first)
  })

  it('emits a single _updated_at column even when declared in json_schema.properties', () => {
    // The source declares `_updated_at: {type: 'integer'}` (unix seconds) on
    // the wire. The destination owns the physical timestamptz shape.
    const schemaWithUpdatedAt: Record<string, unknown> = {
      type: 'object',
      properties: {
        ...(SAMPLE_JSON_SCHEMA.properties as Record<string, unknown>),
        _updated_at: { type: 'integer' },
      },
    }
    const stmts = buildCreateTableWithSchema('stripe', 'customers', schemaWithUpdatedAt)

    expect(stmts[0]).toContain('"_updated_at" timestamptz NOT NULL DEFAULT now()')
    expect(stmts[0]).not.toContain('"_updated_at" bigint')
    expect(stmts[0]).not.toContain('"_updated_at" timestamptz GENERATED ALWAYS')

    const alter = stmts.find((s) => s.includes('ADD COLUMN IF NOT EXISTS')) ?? ''
    expect(alter).not.toContain('"_updated_at"')

    const occurrences = (stmts[0].match(/"_updated_at"/g) || []).length
    expect(occurrences).toBe(1)
  })
})

describe('buildCreateTableDDL', () => {
  it('buildCreateTableDDL does not emit CHECK constraints for JSON Schema enums', () => {
    const ddl = buildCreateTableDDL('stripe', 'events', {
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'cancelled'] },
      },
    })

    expect(ddl).toContain('"status" text GENERATED ALWAYS AS')
    expect(ddl).not.toContain('CHECK')
    expect(ddl).not.toContain('DO $check$')
  })

  it('buildCreateTableDDL skips CHECK when no enum is present in JSON Schema', () => {
    const ddl = buildCreateTableDDL('stripe', 'charges', SAMPLE_JSON_SCHEMA, {
      primary_key: [['id'], ['_account_id']],
    })
    expect(ddl).toContain('"_account_id" text GENERATED ALWAYS AS')
    expect(ddl).not.toContain('DO $check$')
  })
  it('returns a single DO block containing all DDL', () => {
    const ddl = buildCreateTableDDL('mydata', 'repos', SAMPLE_JSON_SCHEMA)

    expect(ddl).toMatch(/^DO \$ddl\$/)
    expect(ddl).toMatch(/\$ddl\$;$/)

    expect(ddl).toContain('CREATE TABLE "mydata"."repos"')
    expect(ddl).toContain('"_raw_data" jsonb NOT NULL')
    expect(ddl).toContain("GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED")
    expect(ddl).toContain('"created" bigint GENERATED ALWAYS AS')

    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "created"')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "deleted"')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "metadata"')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "expires_at"')

    expect(ddl).toContain('"_updated_at" timestamptz NOT NULL DEFAULT now()')
    expect(ddl).not.toContain('CREATE TRIGGER handle_updated_at')
  })

  it('wraps every DDL statement in exception handlers', () => {
    const ddl = buildCreateTableDDL('stripe', 'customers', SAMPLE_JSON_SCHEMA, {
      system_columns: [{ name: '_account_id', type: 'text', index: true }],
    })

    expect(ddl).toContain('EXCEPTION WHEN duplicate_table')
    expect(ddl).toContain('CREATE INDEX')
    expect(ddl).toContain('"_account_id"')

    // Exception handlers: CREATE TABLE, ALTER, CREATE INDEX in $ddl$ (3).
    // No CHECK constraint since SAMPLE_JSON_SCHEMA has no enum on _account_id.
    const exceptionCount = (ddl.match(/EXCEPTION WHEN/g) || []).length
    expect(exceptionCount).toBe(3)
  })

  it('contains every SQL statement from buildCreateTableWithSchema', () => {
    const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

    const schemas = [SAMPLE_JSON_SCHEMA, EXPANDABLE_REF_SCHEMA]
    const optionSets = [
      {},
      { system_columns: [{ name: '_account_id', type: 'text' as const, index: true }] },
      {
        system_columns: [
          { name: '_account_id', type: 'text' as const, index: true },
          { name: '_tenant_id', type: 'uuid' as const, index: false },
        ],
      },
    ]

    for (const schema of schemas) {
      for (const opts of optionSets) {
        const stmts = buildCreateTableWithSchema('s', 't', schema, opts)
        const ddlCollapsed = collapse(buildCreateTableDDL('s', 't', schema, opts))

        for (const stmt of stmts) {
          const stmtCollapsed = collapse(stmt.replace(/;\s*$/, ''))
          expect(ddlCollapsed).toContain(stmtCollapsed)
        }
      }
    }
  })

  it('produces stable output across repeated calls', () => {
    const first = buildCreateTableDDL('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    const second = buildCreateTableDDL('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    expect(second).toEqual(first)
  })
})

describe('relational schema projection contract', () => {
  it('1: one canonical resource table can be created from the projected schema', () => {
    const ddl = buildCreateTableDDL('stripe', 'customer', SAMPLE_JSON_SCHEMA)

    expect(ddl).toContain('CREATE TABLE "stripe"."customer"')
  })

  it('2: table names are singular snake_case and namespace-safe', () => {
    const ddl = buildCreateTableDDL('stripe', 'v2_core_account', SAMPLE_JSON_SCHEMA)

    expect(ddl).toContain('CREATE TABLE "stripe"."v2_core_account"')
  })

  it('3: one row represents one Stripe object keyed by id', () => {
    const ddl = buildCreateTableDDL('stripe', 'customer', SAMPLE_JSON_SCHEMA)

    expect(ddl).toContain('"id" text GENERATED ALWAYS AS')
    expect(ddl).toContain('PRIMARY KEY ("id")')
  })

  it('4: reference column names mirror Stripe field names', () => {
    const ddl = buildCreateTableDDL('stripe', 'charge', EXPANDABLE_REF_SCHEMA)

    expect(ddl).toContain('"customer" text GENERATED ALWAYS AS')
    expect(ddl).not.toContain('"customer_id"')
  })

  it('5: expandable references are stored as ids only', () => {
    const columns = jsonSchemaToColumns(EXPANDABLE_REF_SCHEMA)
    const customer = columns.find((column) => column.name === 'customer')

    expect(customer?.pgType).toBe('text')
    expect(customer?.expression).toContain("->>'id'")
  })

  it('6: reference columns define logical join paths without physical FK constraints', () => {
    const ddl = buildCreateTableDDL('stripe', 'charge', EXPANDABLE_REF_SCHEMA)

    expect(ddl).toContain('"customer" text GENERATED ALWAYS AS')
    expect(ddl).not.toContain('FOREIGN KEY')
  })

  it('7: nested value data is kept inline by default', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)

    expect(columns.find((column) => column.name === 'metadata')?.pgType).toBe('jsonb')
  })

  it('8: list envelopes do not stay on the parent row', () => {
    const columns = jsonSchemaToColumns(LIST_ENVELOPE_SCHEMA)

    expect(columns.map((column) => column.name)).not.toContain('items')
  })

  it('9: strings and enums map to unconstrained text columns', () => {
    const ddl = buildCreateTableDDL('stripe', 'subscription', STRING_ENUM_SCHEMA)
    const columns = jsonSchemaToColumns(STRING_ENUM_SCHEMA)

    expect(columns.find((column) => column.name === 'status')?.pgType).toBe('text')
    expect(ddl).not.toContain('CHECK')
  })

  it('10: booleans map to boolean columns', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)

    expect(columns.find((column) => column.name === 'deleted')?.pgType).toBe('boolean')
  })

  it('11: amount and integer fields map to bigint columns', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)

    expect(columns.find((column) => column.name === 'created')?.pgType).toBe('bigint')
  })

  it('12: OpenAPI number fields map to exact numeric columns', () => {
    const columns = jsonSchemaToColumns({
      type: 'object',
      properties: {
        id: { type: 'string' },
        tax_rate: { type: 'number' },
      },
    })

    expect(columns.find((column) => column.name === 'tax_rate')?.pgType).toBe('numeric')
  })

  it('13: v1 unix timestamps preserve integer shape; v2 date-time fields use date columns', () => {
    const v1Columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)
    expect(v1Columns.find((column) => column.name === 'created')?.pgType).toBe('bigint')

    const v2Columns = jsonSchemaToColumns(V2_DATE_TIME_SCHEMA)
    expect(v2Columns.find((column) => column.name === 'created')?.pgType).toBe('timestamptz')

    const ddl = buildCreateTableDDL('stripe', 'v2_core_account', V2_DATE_TIME_SCHEMA)
    expect(ddl).toContain('"created" timestamptz GENERATED ALWAYS AS')
  })

  it('14: non-scalar values use structured columns unless reference or list behavior overrides them', () => {
    const sampleColumns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)
    const referenceColumns = jsonSchemaToColumns(EXPANDABLE_REF_SCHEMA)

    expect(sampleColumns.find((column) => column.name === 'metadata')?.pgType).toBe('jsonb')
    expect(referenceColumns.find((column) => column.name === 'customer')?.pgType).toBe('text')
  })

  it('15: NOT NULL is reserved for implementation-critical columns', () => {
    const ddl = buildCreateTableDDL('stripe', 'customer', SAMPLE_JSON_SCHEMA)

    expect(ddl).toContain('"_raw_data" jsonb NOT NULL')
    expect(ddl).not.toMatch(/"created" bigint GENERATED ALWAYS AS .* NOT NULL/)
  })

  it('16: deleted resources expose a tombstone _is_deleted metadata column', () => {
    const ddl = buildCreateTableDDL('stripe', 'customer', SAMPLE_JSON_SCHEMA)

    expect(ddl).toContain('"_is_deleted" boolean')
    expect(ddl).toContain("_raw_data->>'deleted'")
  })

  it('17: account-scoped streams use _account_id as part of the primary key', () => {
    const ddl = buildCreateTableDDL('stripe', 'customer', SAMPLE_JSON_SCHEMA, {
      primary_key: [['id'], ['_account_id']],
    })

    expect(ddl).toContain('"_account_id" text GENERATED ALWAYS AS')
    expect(ddl).toContain('PRIMARY KEY ("id", "_account_id")')
  })

  it('18: expandable references get default indexes for join paths', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'charge', EXPANDABLE_REF_SCHEMA)

    expect(
      stmts.some(
        (stmt) =>
          stmt.includes('CREATE INDEX') && stmt.includes('"customer"') && stmt.includes('"charge"')
      )
    ).toBe(true)
  })

  it('19: list envelopes are indexed through the child table relationship', () => {
    const stmts = buildCreateTableWithSchema(
      'stripe',
      'subscription_item',
      CHILD_WITH_PARENT_REF_SCHEMA
    )

    expect(
      stmts.some(
        (stmt) =>
          stmt.includes('CREATE INDEX') &&
          stmt.includes('"subscription"') &&
          stmt.includes('"subscription_item"')
      )
    ).toBe(true)
  })

  it('20: lookup indexes beyond default join paths are not part of the default schema', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'customer', SAMPLE_JSON_SCHEMA)

    expect(stmts.some((stmt) => stmt.includes('CREATE INDEX') && stmt.includes('"created"'))).toBe(
      false
    )
  })
})
