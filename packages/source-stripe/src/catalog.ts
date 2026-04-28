import type { CatalogPayload, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { ParsedResourceTable } from '@stripe/sync-openapi'
import { parsedTableToJsonSchema } from '@stripe/sync-openapi'

/**
 * Derive a CatalogPayload by merging OpenAPI-parsed tables with registry metadata.
 * The JSON Schema stays API-shaped; sync metadata is represented by stream fields
 * like `primary_key` and `newer_than_field`.
 */
export function catalogFromOpenApi(
  tables: ParsedResourceTable[],
  registry: Record<string, ResourceConfig>
): CatalogPayload {
  const tableMap = new Map(tables.map((t) => [t.tableName, t]))

  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => {
      const table = tableMap.get(cfg.tableName)
      if (!table) {
        throw new Error(`No projected OpenAPI table found for syncable resource "${cfg.tableName}"`)
      }
      const stream: Stream = {
        name: cfg.tableName,
        primary_key: [['id'], ['_account_id']],
        newer_than_field: '_updated_at',
        metadata: { resource_name: name },
        json_schema: parsedTableToJsonSchema(table),
      }

      return stream
    })

  return { streams }
}
