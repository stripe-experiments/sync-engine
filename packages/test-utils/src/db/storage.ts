import type pg from 'pg'
import { buildCreateTableWithSchema, runSqlAdditive } from '@stripe/sync-destination-postgres'

export const DEFAULT_STORAGE_SCHEMA = 'stripe'

export type StoredObject = {
  tableName: string
  payload: Record<string, unknown>
}

export async function ensureSchema(
  pool: pg.Pool,
  schema: string = DEFAULT_STORAGE_SCHEMA
): Promise<void> {
  const q = quoteIdentifier
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`)
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${q(schema)}.set_updated_at() RETURNS trigger
        LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW := jsonb_populate_record(
        NEW,
        jsonb_build_object('updated_at', now(), '_updated_at', now())
      );
      RETURN NEW;
    END;
    $$;
  `)
}

export async function ensureObjectTable(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  jsonSchema?: Record<string, unknown>
): Promise<void> {
  if (jsonSchema) {
    const stmts = buildCreateTableWithSchema(schema, tableName, jsonSchema)
    for (const stmt of stmts) {
      await runSqlAdditive(pool, stmt)
    }
    return
  }

  const q = quoteIdentifier
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(tableName)} (
      "_raw_data" jsonb NOT NULL,
      "_last_synced_at" timestamptz,
      "_updated_at" timestamptz NOT NULL DEFAULT now(),
      "id" text GENERATED ALWAYS AS (("_raw_data"->>'id')::text) STORED,
      "created" bigint GENERATED ALWAYS AS (("_raw_data"->>'created')::bigint) STORED,
      PRIMARY KEY ("id")
    )
  `)
}

export async function upsertObjects(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  objects: Record<string, unknown>[]
): Promise<number> {
  if (objects.length === 0) return 0
  const q = quoteIdentifier

  const values: unknown[] = []
  const placeholders: string[] = []
  for (const obj of objects) {
    values.push(JSON.stringify(obj))
    placeholders.push(`($${values.length}::jsonb)`)
  }

  await pool.query(
    `
      INSERT INTO ${q(schema)}.${q(tableName)} ("_raw_data")
      VALUES ${placeholders.join(', ')}
      ON CONFLICT ("id")
      DO UPDATE SET
        "_raw_data" = EXCLUDED."_raw_data",
        "_updated_at" = now()
    `,
    values
  )

  return objects.length
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier "${identifier}"`)
  }
  return `"${identifier}"`
}
