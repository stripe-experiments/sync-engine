import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z.object({
  path: z.string().describe('Path to the SQLite database file (use ":memory:" for in-memory)'),
  batch_size: z.number().default(100).describe('Records to buffer before flushing'),
})

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
