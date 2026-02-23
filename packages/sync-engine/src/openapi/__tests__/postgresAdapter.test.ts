import { describe, expect, it } from 'vitest'
import { PostgresAdapter } from '../postgresAdapter'
import type { ParsedResourceTable } from '../types'

const SAMPLE_TABLE: ParsedResourceTable = {
  tableName: 'customers',
  resourceId: 'customer',
  sourceSchemaName: 'customer',
  columns: [
    { name: 'created', type: 'bigint', nullable: false },
    { name: 'deleted', type: 'boolean', nullable: true },
    { name: 'metadata', type: 'json', nullable: true },
    { name: 'expires_at', type: 'timestamptz', nullable: true },
  ],
}

describe('PostgresAdapter', () => {
  it('emits deterministic DDL statements with runtime-required metadata columns', () => {
    const adapter = new PostgresAdapter({ schemaName: 'stripe' })
    const statements = adapter.buildAllStatements([SAMPLE_TABLE])

    expect(statements).toHaveLength(5)
    expect(statements[0]).toContain('CREATE TABLE "stripe"."customers"')
    expect(statements[0]).toContain('"_raw_data" jsonb NOT NULL')
    expect(statements[0]).toContain('"_account_id" text NOT NULL')
    expect(statements[0]).toContain(
      '"id" text GENERATED ALWAYS AS ((_raw_data->>\'id\')::text) STORED'
    )
    expect(statements[0]).toContain(
      '"metadata" jsonb GENERATED ALWAYS AS ((_raw_data->\'metadata\')::jsonb) STORED'
    )
    // Temporal columns are stored as text generated columns for immutability safety.
    expect(statements[0]).toContain(
      '"expires_at" text GENERATED ALWAYS AS ((_raw_data->>\'expires_at\')::text) STORED'
    )
    expect(statements[1]).toContain(
      'FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id)'
    )
    expect(statements[3]).toContain('DROP TRIGGER IF EXISTS handle_updated_at')
    expect(statements[4]).toContain('EXECUTE FUNCTION set_updated_at()')
  })

  it('produces stable output across repeated calls', () => {
    const adapter = new PostgresAdapter({ schemaName: 'stripe' })
    const first = adapter.buildAllStatements([SAMPLE_TABLE])
    const second = adapter.buildAllStatements([SAMPLE_TABLE])
    expect(second).toEqual(first)
  })
})
