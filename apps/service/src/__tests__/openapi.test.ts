import { describe, it, expect, beforeAll } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import serviceSpec from '../__generated__/openapi.json' with { type: 'json' }

const OAS31_SCHEMA_URL = 'https://spec.openapis.org/oas/3.1/schema/2022-10-07'

/**
 * Inline all `$dynamicRef: "#meta"` anchors as `{"type": ["object", "boolean"]}`.
 * AJV has a known bug where `unevaluatedProperties: false` + `$dynamicRef` leaks
 * outer constraints into nested Schema Object instances, incorrectly flagging valid
 * JSON Schema keywords as unknown properties.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchDynamicRefs(node: any): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) patchDynamicRefs(item)
    return
  }
  if (node['$dynamicRef'] === '#meta') {
    delete node['$dynamicRef']
    node['type'] = ['object', 'boolean']
  }
  for (const value of Object.values(node)) patchDynamicRefs(value)
}

let oas31Schema: Record<string, unknown>

beforeAll(async () => {
  const res = await fetch(OAS31_SCHEMA_URL)
  oas31Schema = await res.json()
  patchDynamicRefs(oas31Schema)
}, 30_000)

describe('Service OpenAPI spec', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const ajv = new Ajv2020({ strict: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validate = ajv.compile(oas31Schema as any)
    const valid = validate(serviceSpec)
    expect(valid, ajv.errorsText(validate.errors)).toBe(true)
  })
})
