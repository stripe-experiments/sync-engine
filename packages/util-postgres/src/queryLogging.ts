import type pg from 'pg'

const verbose = process.env.DANGEROUSLY_VERBOSE_LOGGING === 'true'

function writeStderr(level: string, obj: Record<string, unknown>, msg: string) {
  const entry = JSON.stringify({ level, name: 'util-postgres', msg, ...obj, time: Date.now() })
  process.stderr.write(entry + '\n')
}

/**
 * Wrap a pg.Pool so every query is logged to stderr when
 * DANGEROUSLY_VERBOSE_LOGGING is enabled.
 * Format: structured log with duration, row count, and truncated SQL preview.
 */
export function withQueryLogging<T extends pg.Pool>(pool: T): T {
  if (!verbose) return pool

  const origQuery = pool.query.bind(pool) as typeof pool.query

  function extractSql(args: unknown[]): string | undefined {
    if (typeof args[0] === 'string') return args[0]
    if (args[0] && typeof args[0] === 'object' && 'text' in args[0])
      return (args[0] as { text: string }).text
    return undefined
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pool as any).query = async function (...args: unknown[]) {
    const sql = extractSql(args)
    const sql_preview = sql?.replace(/\s+/g, ' ').slice(0, 300) ?? '(unknown)'
    const start = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (origQuery as any)(...args)
      writeStderr(
        'info',
        {
          duration_ms: Date.now() - start,
          row_count: result?.rowCount ?? 0,
          sql_preview,
        },
        'Postgres query'
      )
      return result
    } catch (err) {
      writeStderr(
        'error',
        {
          duration_ms: Date.now() - start,
          sql_preview,
          err: err instanceof Error ? { type: err.constructor.name, message: err.message } : err,
        },
        'Postgres query failed'
      )
      throw err
    }
  }
  return pool
}
