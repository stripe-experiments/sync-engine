import { envPrefix, mergeConfig, parseJsonOrFile, parseStreams } from '../../config.js'
import type { DecomposedFlag } from './decompose.js'

export interface AssembleContext {
  flags: DecomposedFlag[]
  args: Record<string, string | undefined>
  /** Map of schema property names to env var prefixes.
   *  e.g. { source: 'SOURCE', destination: 'DESTINATION' } */
  envPrefixes?: Record<string, string>
}

/**
 * Assemble decomposed flag values + env vars + config file into a JSON string
 * suitable for setting as a header value.
 *
 * Cascade priority: flags > env vars > config file (first wins per key).
 * Returns undefined if nothing was set.
 */
export function assembleJsonHeader(ctx: AssembleContext): string | undefined {
  const { flags, args, envPrefixes = {} } = ctx

  // 1. Load base config from --config flag
  const baseConfigFlag = flags.find((f) => f.role === 'base-config')
  const baseConfig = baseConfigFlag ? parseJsonOrFile(args[baseConfigFlag.name]) : {}

  const assembled: Record<string, unknown> = {}

  // Group flags by parentProp to handle name+config pairs
  const parentProps = new Set<string>()
  for (const flag of flags) {
    if (flag.parentProp) parentProps.add(flag.parentProp)
  }

  // 2. For each property group that has name+config pattern
  for (const prop of parentProps) {
    const nameFlag = flags.find((f) => f.parentProp === prop && f.role === 'name')
    const configFlag = flags.find((f) => f.parentProp === prop && f.role === 'config')

    // Flag values
    const flagObj: Record<string, unknown> = {}
    if (nameFlag && args[nameFlag.name] !== undefined) {
      flagObj['name'] = args[nameFlag.name]
    }
    const configObj = configFlag ? parseJsonOrFile(args[configFlag.name]) : {}
    const flagValues = { ...configObj, ...flagObj } // name takes precedence over config

    // Env values
    const prefix = envPrefixes[prop]
    const envValues = prefix ? envPrefix(prefix) : {}

    // Base config values for this property
    const fileValues =
      baseConfig[prop] != null && typeof baseConfig[prop] === 'object'
        ? (baseConfig[prop] as Record<string, unknown>)
        : {}

    const merged = mergeConfig(flagValues, envValues, fileValues)
    if (Object.keys(merged).length > 0) {
      assembled[prop] = merged
    }
  }

  // 3. Handle list flags (e.g. --streams)
  for (const flag of flags) {
    if (flag.role !== 'list') continue
    const prop = flag.path[0]!
    const value = args[flag.name]
    if (value !== undefined) {
      assembled[prop] = parseStreams(value)
    } else if (baseConfig[prop] !== undefined) {
      assembled[prop] = baseConfig[prop]
    }
  }

  // 4. Handle json flags (open objects without named properties)
  for (const flag of flags) {
    if (flag.role !== 'json' || flag.path.length === 0) continue
    const prop = flag.path[0]!
    if (prop in assembled) continue // already handled by name+config pattern
    const value = args[flag.name]
    if (value !== undefined) {
      assembled[prop] = parseJsonOrFile(value)
    } else if (baseConfig[prop] !== undefined) {
      assembled[prop] = baseConfig[prop]
    }
  }

  // 5. Handle scalar flags
  for (const flag of flags) {
    if (flag.role !== 'scalar' || flag.path.length === 0) continue
    const prop = flag.path[0]!
    if (prop in assembled) continue
    const value = args[flag.name]
    if (value !== undefined) {
      assembled[prop] = tryNumeric(value)
    } else if (baseConfig[prop] !== undefined) {
      assembled[prop] = baseConfig[prop]
    }
  }

  if (Object.keys(assembled).length === 0) return undefined
  return JSON.stringify(assembled)
}

function tryNumeric(value: string): unknown {
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}
