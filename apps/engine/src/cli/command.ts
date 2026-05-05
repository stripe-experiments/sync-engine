import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import type { ConnectorResolver } from '../lib/index.js'
import { startApiServer } from '../api/server.js'
import { createApp } from '../api/app.js'
import { createSyncCmd } from './sync.js'
import { createResolverFromFlags } from './resolver-flags.js'
import { ENGINE_INTERNAL_REQUEST_HEADER } from '../request-context.js'

const API_META = {
  name: 'api',
  description: 'Raw API operations (runs against a local in-process engine by default)',
  version: '0.1.0',
}

const FLAGS_WITH_VALUES = new Set(['--connectors-from-command-map', '--port'])

function selectedTopLevelCommand(argv: string[]): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg || arg === '--') return undefined
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && FLAGS_WITH_VALUES.has(arg)) i++
      continue
    }
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

/** Connector discovery flags shared by all commands (serve + one-shot). */
const connectorArgs = {
  connectorsFromCommandMap: {
    type: 'string' as const,
    description: 'Explicit connector command mappings (JSON object or @file)',
  },
  noConnectorsFromPath: {
    type: 'boolean' as const,
    default: false,
    description: 'Disable PATH-based connector discovery',
  },
  connectorsFromNpm: {
    type: 'boolean' as const,
    default: false,
    description: 'Enable npm auto-download of connectors (disabled by default)',
  },
}

function createServeCmd(resolverPromise: Promise<ConnectorResolver>) {
  return defineCommand({
    meta: { name: 'serve', description: 'Start the HTTP API server' },
    args: {
      port: { type: 'string', description: 'Port to listen on (or PORT env)' },
      ...connectorArgs,
    },
    async run({ args }) {
      const resolver = await resolverPromise
      await startApiServer({
        resolver,
        port: args.port ? parseInt(args.port) : undefined,
      })
    },
  })
}

async function buildApiCmd(appPromise: ReturnType<typeof createApp>) {
  const app = await appPromise
  const openapiResponse = await Promise.resolve(
    app.request('/openapi.json', {
      headers: { [ENGINE_INTERNAL_REQUEST_HEADER]: 'true' },
    })
  )
  const spec = await openapiResponse.json()

  // Remap verbose spec tags to CLI-friendly group names
  const tagRenames: Record<string, string> = { 'Stateless Sync API': 'pipeline' }
  for (const methods of Object.values(spec.paths ?? {}) as Record<string, { tags?: string[] }>[]) {
    for (const op of Object.values(methods)) {
      if (op.tags) op.tags = op.tags.map((t: string) => tagRenames[t] ?? t)
    }
  }

  return createCliFromSpec({
    spec,
    handler: (req) => Promise.resolve(app.fetch(req)),
    exclude: ['health'],
    groupByTag: true,
    tagDescriptions: {
      pipeline: 'Stateless sync operations (check, setup, read, write, sync)',
      Meta: 'Connector metadata and discovery',
    },
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    meta: API_META,
  })
}

function createApiPlaceholderCmd() {
  return defineCommand({
    meta: API_META,
    run() {
      throw new Error('Internal error: api command was not initialized')
    },
  })
}

export async function createProgram(argv = process.argv) {
  const resolverPromise = createResolverFromFlags(argv)
  const apiCommand =
    selectedTopLevelCommand(argv) === 'api'
      ? await buildApiCmd(resolverPromise.then((resolver) => createApp(resolver)))
      : createApiPlaceholderCmd()

  return defineCommand({
    meta: {
      name: 'sync-engine',
      description: 'Stripe Sync Engine — sync Stripe data to Postgres',
      version: '0.1.0',
    },
    subCommands: {
      serve: createServeCmd(resolverPromise),
      sync: createSyncCmd(resolverPromise),
      api: apiCommand,
    },
  })
}
