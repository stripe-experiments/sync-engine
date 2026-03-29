import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCommand } from 'citty'
import type { CommandDef } from 'citty'
import { toCliFlag } from '../../parse.js'
import { createErgonomicCli } from '../index.js'
import type { OpenAPISpec } from '../../types.js'

// Load the real engine spec
const specPath = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'openapi',
  'engine.json'
)
const engineSpec: OpenAPISpec = JSON.parse(readFileSync(specPath, 'utf-8'))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function optionFlags(cmd: CommandDef): string[] {
  return Object.entries(cmd.args ?? {})
    .filter(([, def]) => def.type !== 'positional')
    .map(([key]) => '--' + toCliFlag(key))
}

function subCommandNames(cmd: CommandDef): string[] {
  return Object.keys(cmd.subCommands ?? {})
}

// ---------------------------------------------------------------------------
// Structure tests: verify decomposed flags appear on the right commands
// ---------------------------------------------------------------------------

describe('createErgonomicCli with engine.json', () => {
  const handler = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

  it('creates subcommands for all operations', () => {
    const root = createErgonomicCli({ spec: engineSpec, handler })
    const names = subCommandNames(root)
    expect(names).toContain('health')
    expect(names).toContain('setup')
    expect(names).toContain('teardown')
    expect(names).toContain('check')
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('sync')
    expect(names).toContain('list-connectors')
  })

  it('read command has decomposed pipeline flags + state flags', () => {
    const root = createErgonomicCli({ spec: engineSpec, handler })
    const readCmd = root.subCommands!['read'] as CommandDef
    const flags = optionFlags(readCmd)

    // Decomposed from x-pipeline
    expect(flags).toContain('--source')
    expect(flags).toContain('--source-config')
    expect(flags).toContain('--destination')
    expect(flags).toContain('--destination-config')
    expect(flags).toContain('--streams')
    expect(flags).toContain('--config')

    // From x-state-checkpoint-limit (non-JSON scalar)
    expect(flags).toContain('--state-checkpoint-limit')
  })

  it('check command has decomposed pipeline flags but no state flags', () => {
    const root = createErgonomicCli({ spec: engineSpec, handler })
    const checkCmd = root.subCommands!['check'] as CommandDef
    const flags = optionFlags(checkCmd)

    expect(flags).toContain('--source')
    expect(flags).toContain('--source-config')
    expect(flags).toContain('--destination')
    expect(flags).toContain('--destination-config')
    expect(flags).toContain('--config')

    // check doesn't have x-state or x-state-checkpoint-limit
    expect(flags).not.toContain('--state-checkpoint-limit')
  })

  it('health command has no decomposed flags', () => {
    const root = createErgonomicCli({ spec: engineSpec, handler })
    const healthCmd = root.subCommands!['health'] as CommandDef
    const flags = optionFlags(healthCmd)

    expect(flags).not.toContain('--source')
    expect(flags).not.toContain('--config')
  })

  it('list-connectors has no decomposed flags', () => {
    const root = createErgonomicCli({ spec: engineSpec, handler })
    const cmd = root.subCommands!['list-connectors'] as CommandDef
    const flags = optionFlags(cmd)

    expect(flags).not.toContain('--source')
    expect(flags).not.toContain('--config')
  })

  it('write command has pipeline flags plus body', () => {
    const root = createErgonomicCli({ spec: engineSpec, handler })
    const writeCmd = root.subCommands!['write'] as CommandDef
    const flags = optionFlags(writeCmd)

    expect(flags).toContain('--source')
    expect(flags).toContain('--destination')
    expect(flags).toContain('--config')
    expect(flags).toContain('--body')
  })
})

// ---------------------------------------------------------------------------
// Integration: mock handler, verify assembled headers
// ---------------------------------------------------------------------------

describe('ergonomic CLI handler integration', () => {
  it('assembles x-pipeline header from decomposed flags', async () => {
    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(new Response(null, { status: 204 }))
    })

    const root = createErgonomicCli({ spec: engineSpec, handler })

    await runCommand(root, {
      rawArgs: [
        'setup',
        '--source',
        'stripe',
        '--source-config',
        '{"api_key":"sk_test_123","api_version":"2024-12-18.acacia"}',
        '--destination',
        'postgres',
        '--destination-config',
        '{"connection_string":"postgresql://localhost/test"}',
      ],
    })

    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]!
    const pipelineHeader = req.headers.get('x-pipeline')
    expect(pipelineHeader).toBeTruthy()

    const pipeline = JSON.parse(pipelineHeader!)
    expect(pipeline.source.name).toBe('stripe')
    expect(pipeline.source.api_key).toBe('sk_test_123')
    expect(pipeline.destination.name).toBe('postgres')
    expect(pipeline.destination.connection_string).toBe('postgresql://localhost/test')
  })

  it('assembles streams from comma-separated flag', async () => {
    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(
        new Response('{"type":"state","stream":"a","data":{}}\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      )
    })

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const root = createErgonomicCli({ spec: engineSpec, handler })

    await runCommand(root, {
      rawArgs: [
        'read',
        '--source',
        'stripe',
        '--source-config',
        '{"api_key":"sk_test"}',
        '--destination',
        'postgres',
        '--streams',
        'accounts,customers',
        '--state-checkpoint-limit',
        '1',
      ],
    })

    writeSpy.mockRestore()

    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]!

    const pipeline = JSON.parse(req.headers.get('x-pipeline')!)
    expect(pipeline.streams).toEqual([{ name: 'accounts' }, { name: 'customers' }])

    // x-state-checkpoint-limit is a non-JSON header
    expect(req.headers.get('x-state-checkpoint-limit')).toBe('1')
  })

  it('uses env var prefixes for source config', async () => {
    // Set env vars
    const savedName = process.env['ERGSRC_NAME']
    const savedKey = process.env['ERGSRC_API_KEY']
    process.env['ERGSRC_NAME'] = 'stripe'
    process.env['ERGSRC_API_KEY'] = 'sk_from_env'

    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(new Response(null, { status: 204 }))
    })

    try {
      const root = createErgonomicCli({
        spec: engineSpec,
        handler,
        envPrefixes: { source: 'ERGSRC' },
      })

      await runCommand(root, {
        rawArgs: [
          'setup',
          '--destination',
          'postgres',
          '--destination-config',
          '{"connection_string":"postgresql://localhost/test"}',
        ],
      })

      expect(capturedRequests).toHaveLength(1)
      const pipeline = JSON.parse(capturedRequests[0]!.headers.get('x-pipeline')!)
      expect(pipeline.source.name).toBe('stripe')
      expect(pipeline.source.api_key).toBe('sk_from_env')
    } finally {
      if (savedName === undefined) delete process.env['ERGSRC_NAME']
      else process.env['ERGSRC_NAME'] = savedName
      if (savedKey === undefined) delete process.env['ERGSRC_API_KEY']
      else process.env['ERGSRC_API_KEY'] = savedKey
    }
  })

  it('supports groupByTag', () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const root = createErgonomicCli({
      spec: engineSpec,
      handler,
      groupByTag: true,
    })

    const groups = subCommandNames(root)
    // toCliFlag doesn't handle spaces — "Stateless Sync API" becomes "stateless sync api"
    expect(groups).toContain('stateless sync api')
    expect(groups).toContain('status')
    expect(groups).toContain('connectors')

    const syncGroup = root.subCommands!['stateless sync api'] as CommandDef
    const syncOps = subCommandNames(syncGroup)
    expect(syncOps).toContain('read')
    expect(syncOps).toContain('sync')
    expect(syncOps).toContain('setup')
  })
})
