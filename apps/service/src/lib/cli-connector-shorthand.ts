import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { z } from 'zod'

export type ConnectorBodyKey = 'source' | 'destination'

export function normalizeCliKey(value: string): string {
  return value
    .replace(/-/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

export function parseCliValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown) {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[path[path.length - 1]!] = value
}

export function applyConnectorShorthand(
  args: Record<string, unknown>,
  bodyKey: ConnectorBodyKey,
  connectorNames: string[]
) {
  const shorthandConfigs = new Map<string, Record<string, unknown>>()
  const connectorByPrefix = new Map(connectorNames.map((name) => [normalizeCliKey(name), name]))

  // Shorthand keys are scoped to a side: `<source|destination>.<connector>.<path...>`.
  // This makes the side explicit so connector names that exist on both sides
  // (e.g. `postgres`, `stripe`) are unambiguous.
  for (const [rawKey, rawValue] of Object.entries(args)) {
    const segments = rawKey.split('.')
    if (segments.length < 3) continue
    if (normalizeCliKey(segments[0]!) !== bodyKey) continue

    const connector = connectorByPrefix.get(normalizeCliKey(segments[1]!))
    if (!connector) continue

    const path = segments.slice(2).map((segment) => normalizeCliKey(segment))
    if (path.length === 0) continue

    const config = shorthandConfigs.get(connector) ?? {}
    setNestedValue(config, path, parseCliValue(rawValue))
    shorthandConfigs.set(connector, config)
  }

  if (shorthandConfigs.size === 0) return args
  if (shorthandConfigs.size > 1) {
    throw new Error(
      `Multiple ${bodyKey} connectors specified via shorthand flags: ${[...shorthandConfigs.keys()].join(', ')}`
    )
  }

  const [connectorName, shorthandConfig] = [...shorthandConfigs.entries()][0]!
  const explicitBody = parseCliValue(args[bodyKey])

  if (explicitBody === undefined) {
    return {
      ...args,
      [bodyKey]: JSON.stringify({
        type: connectorName,
        [connectorName]: shorthandConfig,
      }),
    }
  }

  if (!explicitBody || typeof explicitBody !== 'object' || Array.isArray(explicitBody)) {
    throw new Error(`Expected --${bodyKey} to be a JSON object`)
  }

  const mergedBody = { ...(explicitBody as Record<string, unknown>) }
  const explicitType =
    typeof mergedBody.type === 'string' ? normalizeCliKey(mergedBody.type) : undefined
  if (explicitType && explicitType !== normalizeCliKey(connectorName)) {
    throw new Error(
      `--${bodyKey} type ${String(mergedBody.type)} conflicts with shorthand flags for ${connectorName}`
    )
  }

  mergedBody.type = connectorName
  const existingConfig =
    mergedBody[connectorName] &&
    typeof mergedBody[connectorName] === 'object' &&
    !Array.isArray(mergedBody[connectorName])
      ? (mergedBody[connectorName] as Record<string, unknown>)
      : {}
  mergedBody[connectorName] = { ...existingConfig, ...shorthandConfig }

  return {
    ...args,
    [bodyKey]: JSON.stringify(mergedBody),
  }
}

/**
 * Extracts connector override objects from CLI args.
 * Recognizes scoped shorthand of the form `--source.<connector>.<path>` and
 * `--destination.<connector>.<path>`. Returns `{ source?, destination? }`
 * suitable for merging into pipeline configs or POST bodies.
 */
export function extractConnectorOverrides(
  args: Record<string, unknown>,
  options: { sources: string[]; destinations: string[] }
): { source?: Record<string, unknown>; destination?: Record<string, unknown> } {
  const result: { source?: Record<string, unknown>; destination?: Record<string, unknown> } = {}

  const sourceByPrefix = new Map(options.sources.map((name) => [normalizeCliKey(name), name]))
  const destinationByPrefix = new Map(
    options.destinations.map((name) => [normalizeCliKey(name), name])
  )

  assertNoDottedUnknownFlags(args, options)

  const grouped: {
    source: Map<string, Record<string, unknown>>
    destination: Map<string, Record<string, unknown>>
  } = {
    source: new Map(),
    destination: new Map(),
  }

  for (const [rawKey, rawValue] of Object.entries(args)) {
    const segments = rawKey.split('.')
    if (segments.length < 3) continue

    const side = normalizeCliKey(segments[0]!) as ConnectorBodyKey
    if (side !== 'source' && side !== 'destination') continue

    const lookup = side === 'source' ? sourceByPrefix : destinationByPrefix
    const connector = lookup.get(normalizeCliKey(segments[1]!))
    if (!connector) continue

    const path = segments.slice(2).map((segment) => normalizeCliKey(segment))
    if (path.length === 0) continue

    const config = grouped[side].get(connector) ?? {}
    setNestedValue(config, path, parseCliValue(rawValue))
    grouped[side].set(connector, config)
  }

  for (const side of ['source', 'destination'] as const) {
    for (const [connectorName, config] of grouped[side]) {
      result[side] = { type: connectorName, [connectorName]: config }
    }
  }

  return result
}

/**
 * Merges connector overrides (from extractConnectorOverrides) into a pipeline object in-place.
 * Each override's type-keyed config is shallow-merged on top of the existing connector config.
 * When a Zod configSchema is provided, the merged config is validated through it so that
 * unknown keys and type mismatches are caught immediately.
 */
export function mergeConnectorOverrides(
  pipeline: Record<string, unknown>,
  overrides: { source?: Record<string, unknown>; destination?: Record<string, unknown> },
  configSchemas?: { source?: z.ZodType; destination?: z.ZodType }
) {
  for (const key of ['source', 'destination'] as const) {
    const override = overrides[key]
    if (!override) continue
    const connectorName = override.type as string
    const overrideConfig = override[connectorName] as Record<string, unknown>
    const existing = (pipeline[key] as Record<string, unknown>)?.[connectorName] ?? {}
    const merged = { ...(existing as Record<string, unknown>), ...overrideConfig }

    const schema = configSchemas?.[key]
    if (schema) {
      // Use strict mode so unknown keys (typos) are rejected
      const strict = schema instanceof z.ZodObject ? schema.strict() : schema
      const result = strict.safeParse(merged)
      if (!result.success) {
        const issues = result.error.issues
          .map((i) =>
            i.path.length > 0
              ? `  --${connectorName}.${i.path.join('.')}: ${i.message}`
              : `  ${i.message}`
          )
          .join('\n')
        throw new Error(`Invalid ${key} config override:\n${issues}`)
      }
    }

    pipeline[key] = {
      ...(pipeline[key] as Record<string, unknown>),
      type: connectorName,
      [connectorName]: merged,
    }
  }
}

export function assertNoDottedUnknownFlags(
  args: Record<string, unknown>,
  options: { sources: string[]; destinations: string[] }
) {
  const sources = new Set(options.sources.map(normalizeCliKey))
  const destinations = new Set(options.destinations.map(normalizeCliKey))

  for (const rawKey of Object.keys(args)) {
    const segments = rawKey.split('.')
    if (segments.length < 2) continue

    const side = normalizeCliKey(segments[0]!)
    if (side !== 'source' && side !== 'destination') {
      throw new Error(
        `Unknown connector flag --${rawKey}: must start with "source." or "destination.".`
      )
    }

    if (segments.length < 3) {
      throw new Error(`Unknown connector flag --${rawKey}: expected --${side}.<connector>.<field>.`)
    }

    const connector = normalizeCliKey(segments[1]!)
    const known = side === 'source' ? sources : destinations
    if (!known.has(connector)) {
      throw new Error(
        `Unknown connector flag --${rawKey}: "${connector}" is not a known ${side} connector. ` +
          `Available ${side} connectors: ${
            side === 'source' ? options.sources.join(', ') : options.destinations.join(', ')
          }`
      )
    }
  }
}

export function wrapPipelineConnectorShorthand(
  command: CommandDef,
  options: { sources: string[]; destinations: string[] }
): CommandDef {
  const args = { ...((command.args ?? {}) as Record<string, unknown>) } as Record<string, any>
  if (args.source && typeof args.source === 'object') {
    args.source = { ...args.source, required: false }
  }
  if (args.destination && typeof args.destination === 'object') {
    args.destination = { ...args.destination, required: false }
  }
  args['x-pipeline'] = {
    type: 'string',
    required: false,
    description: 'Full pipeline config as inline JSON or path to a JSON file',
  }
  // Override the auto-generated skipCheck (camelCase string) with kebab-case boolean
  delete args['skipCheck']
  args['skip-check'] = {
    type: 'boolean',
    default: false,
    description: 'Skip connector validation checks',
  }

  return defineCommand({
    ...command,
    args,
    async run(input) {
      let resolvedArgs = input.args as Record<string, unknown>

      // --skip-check → dispatch expects skipCheck (the toOptName key for skip_check)
      if (resolvedArgs['skip-check']) {
        resolvedArgs = { ...resolvedArgs, skipCheck: 'true' }
      }

      // --x-pipeline provides the full PipelineConfig:
      // { source: { type, [type]: {...} }, destination: {...}, streams?: [...] }
      const xPipeline = resolvedArgs['x-pipeline'] as string | undefined
      if (xPipeline) {
        const { parseJsonOrFile } = await import('@stripe/sync-ts-cli')
        const pipelineConfig = parseJsonOrFile(xPipeline)
        // Map PipelineConfig fields to the service body fields
        if (pipelineConfig.source && resolvedArgs.source === undefined) {
          resolvedArgs = { ...resolvedArgs, source: JSON.stringify(pipelineConfig.source) }
        }
        if (pipelineConfig.destination && resolvedArgs.destination === undefined) {
          resolvedArgs = {
            ...resolvedArgs,
            destination: JSON.stringify(pipelineConfig.destination),
          }
        }
        if (pipelineConfig.streams && resolvedArgs.streams === undefined) {
          resolvedArgs = { ...resolvedArgs, streams: JSON.stringify(pipelineConfig.streams) }
        }
      }

      assertNoDottedUnknownFlags(resolvedArgs, options)
      const argsWithSource = applyConnectorShorthand(resolvedArgs, 'source', options.sources)
      const argsWithDestination = applyConnectorShorthand(
        argsWithSource,
        'destination',
        options.destinations
      )
      return command.run?.({ ...input, args: argsWithDestination as any })
    },
  })
}
