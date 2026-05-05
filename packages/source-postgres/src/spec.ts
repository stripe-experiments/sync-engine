import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

const baseConfigFields = {
  schema: z.string().default('public').describe('Schema containing the source table'),
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
}

const configObjectSchema = z.object({
  ...baseConfigFields,
  url: z.string().optional().describe('Postgres connection string'),
  connection_string: z.string().optional().describe('Deprecated alias for url; prefer url'),
  table: z.string().optional().describe('Table to read from'),
  query: z
    .string()
    .optional()
    .describe('SQL query to read from. Must expose the primary_key and cursor_field columns.'),
  stream: z
    .string()
    .optional()
    .describe('Stream name emitted in the catalog and records. Required for query configs.'),
})

export const configSchema = configObjectSchema.superRefine((config, ctx) => {
  if (!config.url && !config.connection_string) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'Either url or connection_string is required',
    })
  }

  if (Boolean(config.table) === Boolean(config.query)) {
    ctx.addIssue({
      code: 'custom',
      path: ['table'],
      message: 'Specify exactly one of table or query',
    })
  }

  if (config.query && !config.stream) {
    ctx.addIssue({
      code: 'custom',
      path: ['stream'],
      message: 'stream is required when query is provided',
    })
  }
})

const configJsonSchemaShape = z.union([
  z.object({
    ...baseConfigFields,
    url: z.string(),
    connection_string: z.string().optional(),
    table: z.string(),
    query: z.never().optional(),
    stream: z.string().optional(),
  }),
  z.object({
    ...baseConfigFields,
    url: z.string().optional(),
    connection_string: z.string(),
    table: z.string(),
    query: z.never().optional(),
    stream: z.string().optional(),
  }),
  z.object({
    ...baseConfigFields,
    url: z.string(),
    connection_string: z.string().optional(),
    table: z.never().optional(),
    query: z.string(),
    stream: z.string(),
  }),
  z.object({
    ...baseConfigFields,
    url: z.string().optional(),
    connection_string: z.string(),
    table: z.never().optional(),
    query: z.string(),
    stream: z.string(),
  }),
])

const configJsonSchema = {
  ...z.toJSONSchema(configJsonSchemaShape),
  type: 'object',
  properties: z.toJSONSchema(configObjectSchema).properties,
}

export type Config = z.infer<typeof configSchema>

export const streamStateSpec = z.object({
  cursor: z.unknown().describe('Last emitted cursor_field value.'),
  primary_key: z.array(z.unknown()).describe('Last emitted primary key tuple at the cursor.'),
})

export type StreamState = z.infer<typeof streamStateSpec>

export default {
  config: configJsonSchema,
  source_state_stream: z.toJSONSchema(streamStateSpec),
} satisfies ConnectorSpecification
