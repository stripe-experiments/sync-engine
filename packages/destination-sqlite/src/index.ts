import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Destination } from '@stripe/sync-protocol'
import defaultSpec from './spec.js'
import { log } from './logger.js'
import type { Config } from './spec.js'

export { configSchema, type Config } from './spec.js'

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function openDatabase(config: Config): DatabaseSync {
  if (config.path !== ':memory:') {
    mkdirSync(dirname(config.path), { recursive: true })
  }
  const db = new DatabaseSync(config.path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function buildCreateTableSQL(tableName: string): string {
  const qt = quoteIdent(tableName)
  return `CREATE TABLE IF NOT EXISTS ${qt} (
  id TEXT NOT NULL PRIMARY KEY,
  _raw_data TEXT NOT NULL,
  _synced_at TEXT NOT NULL,
  _updated_at TEXT NOT NULL
)`
}

function buildUpsertSQL(
  tableName: string,
  entries: Record<string, unknown>[],
  primaryKeyColumns: string[],
  newerThanField: string
): { sql: string; params: unknown[] } {
  if (entries.length === 0) return { sql: '', params: [] }

  const qt = quoteIdent(tableName)
  const pkCols = primaryKeyColumns.map(quoteIdent).join(', ')
  const syncedAt = new Date().toISOString()
  const params: unknown[] = []
  const valueRows: string[] = []

  for (const entry of entries) {
    const ts = entry[newerThanField] as number
    const updatedAt = new Date(ts * 1000).toISOString()
    const pkValues = primaryKeyColumns.map((pk) => String(entry[pk] ?? ''))

    for (const pk of pkValues) params.push(pk)
    params.push(JSON.stringify(entry))
    params.push(syncedAt)
    params.push(updatedAt)

    const placeholders = Array.from(
      { length: primaryKeyColumns.length + 3 },
      (_, i) => `?`
    ).join(', ')
    valueRows.push(`(${placeholders})`)
  }

  const allCols = [...primaryKeyColumns.map(quoteIdent), '"_raw_data"', '"_synced_at"', '"_updated_at"']

  const sql = `INSERT INTO ${qt} (${allCols.join(', ')})
VALUES ${valueRows.join(',\n')}
ON CONFLICT(${pkCols}) DO UPDATE SET
  "_raw_data" = excluded."_raw_data",
  "_synced_at" = excluded."_synced_at",
  "_updated_at" = excluded."_updated_at"
WHERE json_extract(excluded."_raw_data", '$.${newerThanField}') >= json_extract(${qt}."_raw_data", '$.${newerThanField}')`

  return { sql, params }
}

function buildDeleteSQL(
  tableName: string,
  entries: Record<string, unknown>[],
  primaryKeyColumns: string[]
): { sql: string; params: unknown[] } {
  if (entries.length === 0) return { sql: '', params: [] }

  const qt = quoteIdent(tableName)
  const params: unknown[] = []
  const conditions: string[] = []

  for (const entry of entries) {
    const pkConditions = primaryKeyColumns.map((pk) => {
      params.push(String(entry[pk] ?? ''))
      return `${quoteIdent(pk)} = ?`
    })
    conditions.push(`(${pkConditions.join(' AND ')})`)
  }

  const sql = `DELETE FROM ${qt} WHERE ${conditions.join(' OR ')}`
  return { sql, params }
}

export interface WriteManyResult {
  written_count: number
  deleted_count: number
}

function writeMany(
  db: DatabaseSync,
  tableName: string,
  entries: Record<string, unknown>[],
  primaryKeyColumns: string[],
  newerThanField: string
): WriteManyResult {
  const tombstones = entries.filter((e) => e.recordDeleted === true).map((r) => r.data as Record<string, unknown>)
  const liveRecords = entries.filter((e) => e.recordDeleted !== true).map((r) => r.data as Record<string, unknown>)

  let written_count = 0
  let deleted_count = 0

  if (liveRecords.length > 0) {
    const { sql, params } = buildUpsertSQL(tableName, liveRecords, primaryKeyColumns, newerThanField)
    if (sql) {
      db.prepare(sql).run(...(params as Array<string | number | null>))
      written_count = liveRecords.length
    }
  }

  if (tombstones.length > 0) {
    const { sql, params } = buildDeleteSQL(tableName, tombstones, primaryKeyColumns)
    if (sql) {
      db.prepare(sql).run(...(params as Array<string | number | null>))
      deleted_count = tombstones.length
    }
  }

  return { written_count, deleted_count }
}

const destination = {
  async *spec() {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }) {
    try {
      const db = openDatabase(config)
      db.exec('SELECT 1')
      db.close()
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'succeeded' as const },
      }
    } catch (err) {
      yield {
        type: 'connection_status' as const,
        connection_status: {
          status: 'failed' as const,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  },

  async *setup({ config, catalog }) {
    const db = openDatabase(config)
    try {
      log.info(`Creating ${catalog.streams.length} tables in ${config.path}`)
      for (const cs of catalog.streams) {
        const pkFields = (cs.stream.primary_key ?? [['id']]).map((pk) => pk[0])
        const pkCols = pkFields.map(quoteIdent).join(', ')
        const qt = quoteIdent(cs.stream.name)

        db.exec(`CREATE TABLE IF NOT EXISTS ${qt} (
  ${pkFields.map((f) => `${quoteIdent(f)} TEXT NOT NULL`).join(',\n  ')},
  "_raw_data" TEXT NOT NULL,
  "_synced_at" TEXT NOT NULL,
  "_updated_at" TEXT NOT NULL,
  PRIMARY KEY (${pkCols})
)`)
      }
      log.info('Setup complete')
    } finally {
      db.close()
    }
  },

  async *teardown({ config }) {
    const db = openDatabase(config)
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      for (const { name } of tables) {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdent(name)}`)
      }
    } finally {
      db.close()
    }
  },

  async *write({ config, catalog }, $stdin) {
    const db = openDatabase(config)
    const batchSize = config.batch_size

    // Auto-create tables (idempotent)
    for (const cs of catalog.streams) {
      const pkFields = (cs.stream.primary_key ?? [['id']]).map((pk) => pk[0])
      const pkCols = pkFields.map(quoteIdent).join(', ')
      const qt = quoteIdent(cs.stream.name)
      db.exec(`CREATE TABLE IF NOT EXISTS ${qt} (
  ${pkFields.map((f) => `${quoteIdent(f)} TEXT NOT NULL`).join(',\n  ')},
  "_raw_data" TEXT NOT NULL,
  "_synced_at" TEXT NOT NULL,
  "_updated_at" TEXT NOT NULL,
  PRIMARY KEY (${pkCols})
)`)
    }

    const streamBuffers = new Map<string, Record<string, unknown>[]>()
    const streamKeyColumns = new Map(
      catalog.streams.map((cs) => [
        cs.stream.name,
        cs.stream.primary_key?.map((pk) => pk[0]) ?? ['id'],
      ])
    )
    const streamNewerThanField = new Map(
      catalog.streams.map((cs) => [cs.stream.name, cs.stream.newer_than_field])
    )
    const failedStreams = new Set<string>()

    const flushStream = (streamName: string): string | undefined => {
      if (failedStreams.has(streamName)) return undefined
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return undefined
      const pk = streamKeyColumns.get(streamName) ?? ['id']
      const newerThan = streamNewerThanField.get(streamName)!

      try {
        const stats = writeMany(db, streamName, buffer, pk, newerThan)
        log.debug(
          {
            stream: streamName,
            batch_size: buffer.length,
            written: stats.written_count,
            deleted: stats.deleted_count,
          },
          `dest write: upsert ${streamName}`
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.error({ stream: streamName, error: errMsg }, 'dest write: flush failed')
        failedStreams.add(streamName)
        streamBuffers.set(streamName, [])
        return errMsg
      }
      streamBuffers.set(streamName, [])
      return undefined
    }

    function streamError(stream: string, error: string) {
      return {
        type: 'stream_status' as const,
        stream_status: { stream, status: 'error' as const, error },
      }
    }

    try {
      for await (const msg of $stdin) {
        if (msg.type === 'record') {
          const { stream } = msg.record
          if (failedStreams.has(stream)) continue

          if (!streamBuffers.has(stream)) streamBuffers.set(stream, [])
          const buffer = streamBuffers.get(stream)!
          buffer.push(msg.record as Record<string, unknown>)

          if (buffer.length >= batchSize) {
            const err = flushStream(stream)
            if (err) {
              yield streamError(stream, err)
              continue
            }
          }
          yield msg
        } else if (msg.type === 'source_state') {
          if (msg.source_state.state_type !== 'global') {
            const stream = msg.source_state.stream
            if (failedStreams.has(stream)) continue
            const err = flushStream(stream)
            if (err) {
              yield streamError(stream, err)
              continue
            }
          }
          yield msg
        } else {
          yield msg
        }
      }

      for (const streamName of streamBuffers.keys()) {
        const err = flushStream(streamName)
        if (err) yield streamError(streamName, err)
      }

      if (failedStreams.size > 0) {
        log.error(
          { failed_streams: [...failedStreams] },
          `SQLite destination: completed with ${failedStreams.size} failed stream(s)`
        )
      } else {
        log.debug(`SQLite destination: wrote to ${config.path}`)
      }
    } finally {
      db.close()
    }
  },
} satisfies Destination<Config>

export default destination
