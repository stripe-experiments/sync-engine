import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

const customObjectStreamConfigSchema = z
  .object({
    plural_name: z.string().describe('Stripe Custom Object api_name_plural'),
    field_mapping: z
      .record(z.string(), z.string())
      .describe('Mapping from Custom Object field names to source record fields.'),
  })
  .strict()

export const configSchema = z
  .object({
    api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
    api_version: z
      .literal('unsafe-development')
      .describe('Stripe API version for Custom Object write requests'),
    base_url: z
      .string()
      .url()
      .optional()
      .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for tests)'),
    object: z
      .literal('custom_object')
      .describe('Stripe object type to write. Currently only Custom Objects are supported.'),
    write_mode: z.literal('create').describe('Custom Objects are append-only create writes.'),
    streams: z
      .record(z.string(), customObjectStreamConfigSchema)
      .describe('Per-source-stream Custom Object write configuration.'),
    max_retries: z
      .number()
      .int()
      .nonnegative()
      .default(3)
      .describe('Retries for 429/5xx/network errors'),
  })
  .strict()

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
