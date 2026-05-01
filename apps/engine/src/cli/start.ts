import React from 'react'
import { stdin, stderr } from 'node:process'
import { render } from 'ink'
import { defineCommand } from 'citty'
import {
  collectFirst,
  type CatalogPayload,
  type PipelineConfig,
  type ProgressPayload,
} from '@stripe/sync-protocol'
import { ProgressView, formatProgress } from '@stripe/sync-logger/progress'
import { createEngine, type ConnectorListItem, type ConnectorResolver, type Engine } from '../lib/index.js'
import { applyControlToPipeline } from './source-config-cache.js'

type JsonSchema = Record<string, unknown>
const WEBHOOK_FIELD_NAMES = new Set(['webhook_url', 'webhook_secret', 'webhook_port'])

export interface StartPromptIO {
  isTTY: boolean
  write(message: string): void
  question(prompt: string, opts?: { secret?: boolean }): Promise<string>
}

class TerminalPromptIO implements StartPromptIO {
  isTTY = Boolean(stdin.isTTY)

  write(message: string): void {
    stderr.write(message)
  }

  async question(prompt: string, opts?: { secret?: boolean }): Promise<string> {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      this.write(prompt)
      stdin.resume()
      return await new Promise((resolve) => {
        stdin.once('data', (chunk) => resolve(String(chunk).trimEnd()))
      })
    }

    return await new Promise((resolve) => {
      const wasRaw = stdin.isRaw
      let value = ''
      const cleanup = () => {
        stdin.off('data', onData)
        stdin.setRawMode(wasRaw)
        stdin.pause()
      }
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003') {
            cleanup()
            this.write('\n')
            process.kill(process.pid, 'SIGINT')
            return
          }
          if (char === '\r' || char === '\n') {
            cleanup()
            this.write('\n')
            resolve(value)
            return
          }
          if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1)
              if (!opts?.secret) this.write('\b \b')
            }
            continue
          }
          value += char
          if (!opts?.secret) this.write(char)
        }
      }
      this.write(prompt)
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
    })
  }
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const props = schema.properties
  return props && typeof props === 'object' && !Array.isArray(props)
    ? (props as Record<string, JsonSchema>)
    : {}
}

function schemaRequired(schema: JsonSchema): Set<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
}

function schemaType(schema: JsonSchema): string | undefined {
  const type = schema.type
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return type.find((t) => t !== 'null')
  return undefined
}

function isSecretField(name: string): boolean {
  return /(^|_)(api_)?key$|token|secret|password/i.test(name)
}

function isWebhookField(name: string): boolean {
  return WEBHOOK_FIELD_NAMES.has(name)
}

function webhookSiteToken(webhookUrl: string): string | undefined {
  try {
    const url = new URL(webhookUrl)
    if (url.hostname !== 'webhook.site') return undefined
    const token = url.pathname.split('/').filter(Boolean)[0]
    return token || undefined
  } catch {
    return undefined
  }
}

function parseValue(raw: string, schema: JsonSchema): unknown {
  const type = schemaType(schema)
  if (type === 'string' || type === undefined) return raw
  if (type === 'integer' || type === 'number') {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got "${raw}"`)
    return parsed
  }
  if (type === 'boolean') {
    if (/^(true|t|yes|y|1)$/i.test(raw)) return true
    if (/^(false|f|no|n|0)$/i.test(raw)) return false
    throw new Error(`Expected true/false, got "${raw}"`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Expected ${type} JSON, got "${raw}"`)
  }
}

export function parseStreamCsv(raw: string): string[] {
  const seen = new Set<string>()
  const streams: string[] = []
  for (const part of raw.split(',')) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    streams.push(name)
  }
  return streams
}

async function promptYesNo(io: StartPromptIO, prompt: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: '
  while (true) {
    const raw = (await io.question(prompt + suffix)).trim()
    if (!raw) return defaultYes
    if (/^(y|yes)$/i.test(raw)) return true
    if (/^(n|no)$/i.test(raw)) return false
    io.write('Please enter y or n.\n')
  }
}

async function promptChoice(
  io: StartPromptIO,
  label: string,
  items: ConnectorListItem[]
): Promise<ConnectorListItem> {
  if (items.length === 0) throw new Error(`No ${label.toLowerCase()} connectors are registered`)
  if (items.length === 1) {
    io.write(`${label}: ${items[0].type}\n`)
    return items[0]
  }
  io.write(`\n${label}s:\n`)
  items.forEach((item, index) => io.write(`  ${index + 1}. ${item.type}\n`))
  while (true) {
    const raw = (await io.question(`Select ${label.toLowerCase()} [number or name]: `)).trim()
    const index = Number(raw)
    if (Number.isInteger(index) && index >= 1 && index <= items.length) return items[index - 1]
    const byName = items.find((item) => item.type === raw)
    if (byName) return byName
    io.write(`Unknown ${label.toLowerCase()} "${raw}".\n`)
  }
}

async function promptField(
  io: StartPromptIO,
  name: string,
  schema: JsonSchema,
  required: boolean
): Promise<unknown | undefined> {
  const description = typeof schema.description === 'string' ? ` - ${schema.description}` : ''
  const hint = required ? '' : ' (optional, blank to skip)'
  while (true) {
    const raw = await io.question(`${name}${hint}${description}: `, { secret: isSecretField(name) })
    const trimmed = raw.trim()
    if (!trimmed) {
      if (!required) return undefined
      io.write(`${name} is required.\n`)
      continue
    }
    try {
      return parseValue(trimmed, schema)
    } catch (err) {
      io.write(`${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

async function promptConnectorConfig(
  io: StartPromptIO,
  role: 'source' | 'destination',
  connector: ConnectorListItem,
  opts: {
    skipFields?: Set<string>
    promptRequired?: boolean
    promptOptional?: boolean
    header?: boolean
  } = {}
): Promise<Record<string, unknown>> {
  const properties = schemaProperties(connector.config_schema)
  const required = schemaRequired(connector.config_schema)
  const entries = Object.entries(properties).filter(([name]) => !opts.skipFields?.has(name))
  const requiredEntries =
    opts.promptRequired === false ? [] : entries.filter(([name]) => required.has(name))
  const optionalEntries =
    opts.promptOptional === false ? [] : entries.filter(([name]) => !required.has(name))
  const config: Record<string, unknown> = {}

  if (opts.header !== false) {
    io.write(`\n${role === 'source' ? 'Source' : 'Destination'} config (${connector.type})\n`)
  }
  for (const [name, schema] of requiredEntries) {
    config[name] = await promptField(io, name, schema, true)
  }
  if (optionalEntries.length > 0) {
    const configureOptional = await promptYesNo(
      io,
      `Configure optional ${role} fields?`,
      requiredEntries.length === 0
    )
    if (configureOptional) {
      for (const [name, schema] of optionalEntries) {
        const value = await promptField(io, name, schema, false)
        if (value !== undefined) config[name] = value
      }
    }
  }
  return config
}

async function promptLiveWebhookConfig(
  io: StartPromptIO,
  source: ConnectorListItem
): Promise<Record<string, unknown>> {
  const properties = schemaProperties(source.config_schema)
  const webhookEntries = Object.entries(properties).filter(([name]) => isWebhookField(name))
  if (webhookEntries.length === 0) return {}

  const enabled = await promptYesNo(io, `Enable live webhook sync for ${source.type}?`, false)
  if (!enabled) return {}

  const config: Record<string, unknown> = {}
  io.write('\nLive webhook config\n')
  if (source.type === 'stripe') {
    io.write(
      'Stripe setup can create a managed webhook endpoint for this URL. If you are reusing an existing endpoint, paste its signing secret.\n'
    )
  } else if (source.type === 'metronome') {
    io.write(
      'Metronome webhooks are registered in Metronome. Paste that URL and signing secret here; setup validates and prints the local relay instructions.\n'
    )
  }

  const webhookUrlSchema = properties.webhook_url
  if (webhookUrlSchema) {
    config.webhook_url = await promptField(io, 'webhook_url', webhookUrlSchema, true)
  }

  const webhookSecretSchema = properties.webhook_secret
  if (webhookSecretSchema) {
    const secretRequired = source.type === 'metronome'
    const secret = await promptField(io, 'webhook_secret', webhookSecretSchema, secretRequired)
    if (secret !== undefined) config.webhook_secret = secret
  }

  const webhookPortSchema = properties.webhook_port
  if (webhookPortSchema) {
    config.webhook_port = await promptField(io, 'webhook_port', webhookPortSchema, true)
  }

  const url = typeof config.webhook_url === 'string' ? config.webhook_url : undefined
  const port = typeof config.webhook_port === 'number' ? config.webhook_port : undefined
  if (url && port) {
    io.write('\nWebhook delivery summary\n')
    io.write(`  Public URL: ${url}\n`)
    io.write(`  Local listener: http://127.0.0.1:${port}\n`)

    const token = webhookSiteToken(url)
    if (token) {
      io.write('\nRun this in another terminal before starting live delivery:\n')
      io.write(`  ./scripts/webhook-relay.sh ${token} http://127.0.0.1:${port}\n`)
    } else {
      io.write('\nForward your public URL to the local listener above.\n')
    }
  }

  return config
}

async function promptStreams(
  io: StartPromptIO,
  streams: CatalogPayload['streams']
): Promise<PipelineConfig['streams'] | undefined> {
  const allowed = new Set(streams.map((stream) => stream.name))
  io.write(`\nDiscovered ${streams.length} stream(s).\n`)
  io.write(`Examples: ${streams.slice(0, 8).map((stream) => stream.name).join(', ')}\n`)
  while (true) {
    const names = parseStreamCsv(await io.question('Streams CSV (blank = all): '))
    if (names.length === 0) return undefined
    const unknown = names.filter((name) => !allowed.has(name))
    if (unknown.length === 0) return names.map((name) => ({ name }))
    io.write(`Unknown stream(s): ${unknown.join(', ')}\n`)
  }
}

async function runCheck(engine: Pick<Engine, 'pipeline_check'>, pipeline: PipelineConfig, io: StartPromptIO) {
  io.write('\nChecking source and destination...\n')
  let failed = false
  for await (const msg of engine.pipeline_check(pipeline)) {
    if (msg.type !== 'connection_status') continue
    const tag = msg._emitted_by ?? 'connector'
    if (msg.connection_status.status === 'succeeded') {
      io.write(`OK ${tag}\n`)
    } else {
      failed = true
      io.write(`FAIL ${tag}: ${msg.connection_status.message ?? 'connection failed'}\n`)
    }
  }
  if (failed) throw new Error('Connector check failed')
}

async function runSetupAndSync(
  engine: Pick<Engine, 'pipeline_setup' | 'pipeline_sync'>,
  initialPipeline: PipelineConfig,
  opts: { plain?: boolean; skipSetup?: boolean; timeLimit?: number }
) {
  let pipeline = initialPipeline
  if (!opts.skipSetup) {
    for await (const msg of engine.pipeline_setup(pipeline)) {
      if (msg.type === 'control') pipeline = applyControlToPipeline(pipeline, msg.control)
    }
  }

  let progress: ProgressPayload | undefined
  let prevProgress: ProgressPayload | undefined
  let lastRenderAt = 0
  const plain = opts.plain || !process.stderr.isTTY
  const ink = plain ? null : render(React.createElement(React.Fragment), { stdout: process.stderr })

  function show(next: ProgressPayload, previous?: ProgressPayload) {
    if (ink) ink.rerender(React.createElement(ProgressView, { progress: next, prev: previous }))
    else process.stderr.write(formatProgress(next, previous) + '\n')
    lastRenderAt = Date.now()
  }

  try {
    for await (const msg of engine.pipeline_sync(pipeline, { time_limit: opts.timeLimit })) {
      if (msg.type === 'control') {
        pipeline = applyControlToPipeline(pipeline, msg.control)
      } else if (msg.type === 'progress') {
        prevProgress = progress
        progress = msg.progress
        if (Date.now() - lastRenderAt >= 200) show(progress, prevProgress)
      } else if (msg.type === 'eof') {
        prevProgress = progress
        progress = msg.eof.run_progress
        show(progress, prevProgress)
      }
    }
  } finally {
    ink?.unmount()
  }
}

export interface StartWizardOptions {
  plain?: boolean
  skipCheck?: boolean
  skipSetup?: boolean
  timeLimit?: number
}

export async function runStartWizard(engine: Engine, io: StartPromptIO, opts: StartWizardOptions = {}) {
  if (!io.isTTY) {
    throw new Error(
      'sync-engine start is interactive and requires a TTY. For scripts, use `sync-engine api pipeline pipeline-sync --pipeline ...`.'
    )
  }

  io.write('Stripe Sync Engine - interactive local sync\n')
  io.write('This command will not start Docker or provision local infrastructure.\n')

  const source = await promptChoice(io, 'Source', (await engine.meta_sources_list()).items)
  const sourceConfig = {
    ...(await promptConnectorConfig(io, 'source', source, {
      skipFields: WEBHOOK_FIELD_NAMES,
      promptOptional: false,
    })),
    ...(await promptLiveWebhookConfig(io, source)),
    ...(await promptConnectorConfig(io, 'source', source, {
      skipFields: WEBHOOK_FIELD_NAMES,
      promptRequired: false,
      header: false,
    })),
  }
  const sourceEnvelope = { type: source.type, [source.type]: sourceConfig } as PipelineConfig['source']
  const catalog = await collectFirst(engine.source_discover(sourceEnvelope), 'catalog')

  const destination = await promptChoice(
    io,
    'Destination',
    (await engine.meta_destinations_list()).items
  )
  const destinationConfig = await promptConnectorConfig(io, 'destination', destination)
  const destinationEnvelope = {
    type: destination.type,
    [destination.type]: destinationConfig,
  } as PipelineConfig['destination']
  const streams = await promptStreams(io, catalog.catalog.streams)
  const pipeline: PipelineConfig = {
    source: sourceEnvelope,
    destination: destinationEnvelope,
    ...(streams ? { streams } : {}),
  }

  if (!opts.skipCheck) await runCheck(engine, pipeline, io)

  io.write(opts.skipSetup ? '\nStarting sync...\n' : '\nRunning setup, then starting sync...\n')
  await runSetupAndSync(engine, pipeline, opts)
}

export function createStartCmd(resolverPromise: Promise<ConnectorResolver>) {
  return defineCommand({
    meta: {
      name: 'start',
      description: 'Start an interactive local sync run',
    },
    args: {
      'skip-check': {
        type: 'boolean',
        default: false,
        description: 'Skip source/destination connection checks',
      },
      'skip-setup': {
        type: 'boolean',
        default: false,
        description: 'Skip connector setup hooks',
      },
      'time-limit': {
        type: 'string',
        description: 'Stop after N seconds',
      },
      plain: {
        type: 'boolean',
        default: false,
        description: 'Plain text output (no Ink/ANSI)',
      },
    },
    async run({ args }) {
      const engine = await createEngine(await resolverPromise)
      await runStartWizard(engine, new TerminalPromptIO(), {
        plain: args.plain,
        skipCheck: args['skip-check'],
        skipSetup: args['skip-setup'],
        timeLimit: args['time-limit'] ? parseInt(args['time-limit']) : undefined,
      })
    },
  })
}
