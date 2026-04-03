import { describe, it, expect } from 'vitest'
import { validate } from '@hyperjump/json-schema/openapi-3-1'
import { createApp, createConnectorResolver } from '../index.js'
import { defaultConnectors } from '../lib/default-connectors.js'

const resolver = createConnectorResolver(defaultConnectors)
const app = createApp(resolver)

async function getSpec() {
  const res = await app.request('/openapi.json')
  return res.json()
}

describe('Engine OpenAPI spec', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const spec = await getSpec()
    const output = await validate('https://spec.openapis.org/oas/3.1/schema-base', spec, 'BASIC')
    const errors =
      output.errors
        ?.map(
          (e: { instanceLocation: string; absoluteKeywordLocation: string }) =>
            `${e.instanceLocation}: ${e.absoluteKeywordLocation}`
        )
        .join('\n') ?? ''
    expect(output.valid, errors).toBe(true)
  })

  it('has typed SourceConfig and DestinationConfig', async () => {
    const spec = await getSpec()
    const schemas = spec.components.schemas
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'StripeSourceConfig',
        'PostgresDestinationConfig',
        'GoogleSheetsDestinationConfig',
        'SourceConfig',
        'DestinationConfig',
        'PipelineConfig',
      ])
    )
  })

  it('has no $schema in component schemas', async () => {
    const spec = await getSpec()
    for (const [name, schema] of Object.entries<Record<string, unknown>>(spec.components.schemas)) {
      expect(schema, `${name} should not have $schema`).not.toHaveProperty('$schema')
    }
  })
})
