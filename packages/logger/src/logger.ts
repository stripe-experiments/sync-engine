import pino, { type Logger, type LoggerOptions } from 'pino'
import { REDACT_CENSOR, REDACT_PATHS } from './redaction.js'

export type { Logger }

export type CreateLoggerOptions = {
  name?: string
  level?: string
  /** Additional redaction paths beyond the defaults */
  redactPaths?: string[]
  /** Enable pretty-printing (reads LOG_PRETTY env var by default) */
  pretty?: boolean
  /** Pino destination — defaults to stdout (fd 1) */
  destination?: pino.DestinationStream | number
}

/**
 * Create a structured logger with PII redaction built in.
 * All sync-engine packages should use this instead of raw console calls.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info'
  const pretty = opts.pretty ?? !!process.env.LOG_PRETTY

  const redactPaths = [...REDACT_PATHS, ...(opts.redactPaths ?? [])]

  const options: LoggerOptions = {
    level,
    redact: {
      paths: redactPaths,
      censor: REDACT_CENSOR,
    },
    ...(opts.name ? { name: opts.name } : {}),
  }

  if (pretty) {
    options.transport = { target: 'pino-pretty' }
  }

  if (opts.destination != null) {
    return pino(
      options,
      typeof opts.destination === 'number' ? pino.destination(opts.destination) : opts.destination
    )
  }

  return pino(options)
}

const STDERR_FD = 2

/**
 * Create a logger that writes structured JSON to stderr.
 * Designed for subprocess connectors where stdout is the NDJSON data stream.
 */
export function createConnectorLogger(name: string): Logger {
  return createLogger({ name, destination: STDERR_FD })
}
