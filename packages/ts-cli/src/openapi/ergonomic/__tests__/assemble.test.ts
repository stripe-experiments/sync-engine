import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DecomposedFlag } from '../decompose.js'
import { assembleJsonHeader } from '../assemble.js'

// Helper to create a minimal flag
function flag(
  overrides: Partial<DecomposedFlag> & { name: string; role: DecomposedFlag['role'] }
): DecomposedFlag {
  return {
    cliFlag: '--' + overrides.name,
    type: 'string',
    required: false,
    description: '',
    path: [],
    ...overrides,
  }
}

describe('assembleJsonHeader', () => {
  it('assembles name+config flags into nested object', () => {
    const flags: DecomposedFlag[] = [
      flag({ name: 'source', role: 'name', path: ['source', 'name'], parentProp: 'source' }),
      flag({ name: 'sourceConfig', role: 'config', path: ['source'], parentProp: 'source' }),
      flag({
        name: 'destination',
        role: 'name',
        path: ['destination', 'name'],
        parentProp: 'destination',
      }),
      flag({
        name: 'destinationConfig',
        role: 'config',
        path: ['destination'],
        parentProp: 'destination',
      }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    const result = assembleJsonHeader({
      flags,
      args: {
        source: 'stripe',
        sourceConfig: '{"api_key":"sk_test_123"}',
        destination: 'postgres',
        destinationConfig: '{"connection_string":"postgresql://..."}',
      },
    })

    const parsed = JSON.parse(result!)
    expect(parsed.source).toEqual({ name: 'stripe', api_key: 'sk_test_123' })
    expect(parsed.destination).toEqual({ name: 'postgres', connection_string: 'postgresql://...' })
  })

  it('assembles list flags as array of objects', () => {
    const flags: DecomposedFlag[] = [
      flag({ name: 'streams', role: 'list', path: ['streams'] }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    const result = assembleJsonHeader({
      flags,
      args: { streams: 'accounts,customers,products' },
    })

    const parsed = JSON.parse(result!)
    expect(parsed.streams).toEqual([
      { name: 'accounts' },
      { name: 'customers' },
      { name: 'products' },
    ])
  })

  it('name flag overrides name from config', () => {
    const flags: DecomposedFlag[] = [
      flag({ name: 'source', role: 'name', path: ['source', 'name'], parentProp: 'source' }),
      flag({ name: 'sourceConfig', role: 'config', path: ['source'], parentProp: 'source' }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    const result = assembleJsonHeader({
      flags,
      args: {
        source: 'stripe',
        sourceConfig: '{"name":"should-be-overridden","api_key":"sk_test"}',
      },
    })

    const parsed = JSON.parse(result!)
    expect(parsed.source.name).toBe('stripe')
    expect(parsed.source.api_key).toBe('sk_test')
  })

  it('returns undefined when nothing is set', () => {
    const flags: DecomposedFlag[] = [
      flag({ name: 'source', role: 'name', path: ['source', 'name'], parentProp: 'source' }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    const result = assembleJsonHeader({
      flags,
      args: {},
    })

    expect(result).toBeUndefined()
  })

  it('reads config from file via --config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assemble-test-'))
    const configPath = join(dir, 'pipeline.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        source: { name: 'stripe', api_key: 'sk_from_file' },
        destination: { name: 'postgres' },
        streams: [{ name: 'accounts' }],
      })
    )

    const flags: DecomposedFlag[] = [
      flag({ name: 'source', role: 'name', path: ['source', 'name'], parentProp: 'source' }),
      flag({ name: 'sourceConfig', role: 'config', path: ['source'], parentProp: 'source' }),
      flag({
        name: 'destination',
        role: 'name',
        path: ['destination', 'name'],
        parentProp: 'destination',
      }),
      flag({
        name: 'destinationConfig',
        role: 'config',
        path: ['destination'],
        parentProp: 'destination',
      }),
      flag({ name: 'streams', role: 'list', path: ['streams'] }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    const result = assembleJsonHeader({
      flags,
      args: { config: configPath },
    })

    const parsed = JSON.parse(result!)
    expect(parsed.source).toEqual({ name: 'stripe', api_key: 'sk_from_file' })
    expect(parsed.destination).toEqual({ name: 'postgres' })
    expect(parsed.streams).toEqual([{ name: 'accounts' }])
  })

  it('cascade: flags > env > file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assemble-cascade-'))
    const configPath = join(dir, 'base.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        source: { name: 'from-file', api_key: 'from-file', base_url: 'from-file' },
      })
    )

    const flags: DecomposedFlag[] = [
      flag({ name: 'source', role: 'name', path: ['source', 'name'], parentProp: 'source' }),
      flag({ name: 'sourceConfig', role: 'config', path: ['source'], parentProp: 'source' }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    // Set env vars
    const saved: Record<string, string | undefined> = {}
    saved['SRCTEST_NAME'] = process.env['SRCTEST_NAME']
    saved['SRCTEST_API_KEY'] = process.env['SRCTEST_API_KEY']
    process.env['SRCTEST_NAME'] = 'from-env'
    process.env['SRCTEST_API_KEY'] = 'from-env'

    try {
      const result = assembleJsonHeader({
        flags,
        args: {
          source: 'from-flag', // flag wins over env and file
          config: configPath,
        },
        envPrefixes: { source: 'SRCTEST' },
      })

      const parsed = JSON.parse(result!)
      expect(parsed.source.name).toBe('from-flag') // flag wins
      expect(parsed.source.api_key).toBe('from-env') // env wins over file
      expect(parsed.source.base_url).toBe('from-file') // file fills in remaining
    } finally {
      // Restore env
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  describe('env var integration', () => {
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('ERGTEST_')) {
          saved[key] = process.env[key]
        }
      }
    })

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('ERGTEST_')) {
          delete process.env[key]
        }
      }
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })

    it('picks up env vars for a property group', () => {
      process.env['ERGTEST_NAME'] = 'stripe'
      process.env['ERGTEST_API_KEY'] = 'sk_test_env'

      const flags: DecomposedFlag[] = [
        flag({ name: 'source', role: 'name', path: ['source', 'name'], parentProp: 'source' }),
        flag({ name: 'sourceConfig', role: 'config', path: ['source'], parentProp: 'source' }),
        flag({ name: 'config', role: 'base-config', path: [] }),
      ]

      const result = assembleJsonHeader({
        flags,
        args: {},
        envPrefixes: { source: 'ERGTEST' },
      })

      const parsed = JSON.parse(result!)
      expect(parsed.source).toEqual({ name: 'stripe', api_key: 'sk_test_env' })
    })
  })

  it('handles scalar flags', () => {
    const flags: DecomposedFlag[] = [
      flag({ name: 'limit', role: 'scalar', path: ['limit'] }),
      flag({ name: 'config', role: 'base-config', path: [] }),
    ]

    const result = assembleJsonHeader({
      flags,
      args: { limit: '42' },
    })

    const parsed = JSON.parse(result!)
    expect(parsed.limit).toBe(42)
  })
})
