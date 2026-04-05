import { describe, it, expect } from 'vitest'
import spec, { configSchema } from './spec.js'
import { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS } from '@stripe/sync-openapi'

describe('configSchema api_version field', () => {
  it('accepts any version string at runtime (not just the enum)', () => {
    expect(configSchema.shape.api_version.safeParse('2024-12-18.acacia').success).toBe(true)
    expect(configSchema.shape.api_version.safeParse('2023-08-16').success).toBe(true)
  })

  it('exposes supported versions via JSON Schema anyOf enum', () => {
    const jsonSchema = spec.config as {
      properties?: Record<string, { anyOf?: Array<{ enum?: string[] }>; description?: string }>
    }
    const field = jsonSchema.properties?.api_version

    expect(field).toBeDefined()
    // Enum is nested in anyOf[0] so z.fromJSONSchema produces a union that accepts any string
    expect(field!.anyOf?.[0]?.enum).toEqual([...SUPPORTED_API_VERSIONS])
    expect(field!.description).toContain(BUNDLED_API_VERSION)
  })

  it('clients can extract supported API versions from config_schema', () => {
    // This is the pattern clients use: read config_schema from
    // GET /meta/sources/stripe, then inspect the api_version field.
    const schema = spec.config as {
      properties?: Record<string, { anyOf?: Array<{ enum?: string[] }> }>
    }
    const versions: string[] = schema.properties?.api_version?.anyOf?.[0]?.enum ?? []

    expect(versions).toContain(BUNDLED_API_VERSION)
    expect(versions.length).toBeGreaterThan(0)
  })
})
