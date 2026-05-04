import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z
  .object({
    url: z.string().optional().describe('Postgres connection string'),
    connection_string: z.string().optional().describe('Deprecated alias for url; prefer url'),
    schema: z.string().default('public').describe('Schema containing the source table'),
    table: z.string().optional().describe('Table to read from'),
    query: z
      .string()
      .optional()
      .describe('SQL query to read from. Must expose the primary_key and cursor_field columns.'),
    stream: z
      .string()
      .optional()
      .describe('Stream name emitted in the catalog and records. Defaults to table name.'),
    primary_key: z
      .array(z.string())
      .min(1)
      .default(['id'])
      .describe('Columns that uniquely identify a row in this stream'),
    cursor_field: z.string().describe('Monotonic column used for incremental reads'),
    page_size: z.number().int().positive().default(100).describe('Rows to read per page'),
    ssl_ca_pem: z
      .string()
      .optional()
      .describe(
        'PEM-encoded CA certificate for SSL verification (required for verify-ca / verify-full with a private CA)'
      ),
  })
  .refine((config) => Boolean(config.url || config.connection_string), {
    message: 'Either url or connection_string is required',
    path: ['url'],
  })
  .refine((config) => Boolean(config.table) !== Boolean(config.query), {
    message: 'Specify exactly one of table or query',
    path: ['table'],
  })
  .refine((config) => Boolean(config.stream || config.table), {
    message: 'stream is required when using query',
    path: ['stream'],
  })

export type Config = z.infer<typeof configSchema>

export const streamStateSpec = z.object({
  cursor: z.unknown().describe('Last emitted cursor_field value.'),
  primary_key: z.array(z.unknown()).describe('Last emitted primary key tuple at the cursor.'),
})

export type StreamState = z.infer<typeof streamStateSpec>

export default {
  config: z.toJSONSchema(configSchema),
  source_state_stream: z.toJSONSchema(streamStateSpec),
} satisfies ConnectorSpecification
