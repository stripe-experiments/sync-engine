import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  api_version: z.string().describe('Stripe API version to send on write requests'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for tests)'),
  object: z
    .string()
    .default('customer')
    .describe('Stripe object type to write. Only "customer" is supported by this MVP.'),
  mode: z.literal('upsert').default('upsert').describe('Write mode'),
  allow_create: z.boolean().default(false).describe('Whether missing Customers may be created'),
  identity: z
    .object({
      stripe_id_field: z
        .string()
        .optional()
        .describe('Source record field containing an existing Stripe Customer ID'),
      external_id_field: z
        .string()
        .describe('Source record field containing the external identity'),
      metadata_key: z
        .string()
        .default('reverse_etl_external_id')
        .describe('Stripe Customer metadata key used for external identity lookup'),
    })
    .describe('How source rows map to Stripe Customers'),
  fields: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'Mapping from Stripe Customer fields to source record fields. Supports top-level fields like email/name and metadata[key].'
    ),
  max_retries: z
    .number()
    .int()
    .nonnegative()
    .default(3)
    .describe('Retries for 429/5xx/network errors'),
})

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
