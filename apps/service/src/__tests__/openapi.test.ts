import { describe, it, expect } from 'vitest'
import { validate } from '@hyperjump/json-schema/openapi-3-1'
import serviceSpec from '../__generated__/openapi.json' with { type: 'json' }

describe('Service OpenAPI spec', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const output = await validate('https://spec.openapis.org/oas/3.1/schema-base', serviceSpec, 'BASIC')
    const errors =
      output.errors
        ?.map(
          (e: { instanceLocation: string; absoluteKeywordLocation: string }) =>
            `${e.instanceLocation}: ${e.absoluteKeywordLocation}`
        )
        .join('\n') ?? ''
    expect(output.valid, errors).toBe(true)
  })
})
