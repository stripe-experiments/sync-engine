import type { RawJsonUpsertOptions } from './postgres'

/**
 * Interface for sync database clients.
 *
 * Implemented by:
 * - PostgresClient: Full feature support (advisory locks, sync observability)
 * - BaseSyncClient: Core sync operations for DuckDB, SQLite, MySQL
 *
 * NOTE: This interface uses `any` for complex return types to allow
 * different implementations to coexist without strict type matching.
 * PostgresClient returns full objects; other databases return null/no-op
 * for PostgreSQL-specific features.
 */
export interface SyncDatabaseClient {
  // Query execution - required for all database types
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>

  // Core sync operations - required for all database types
  delete(table: string, id: string): Promise<boolean>
  upsertManyWithTimestampProtection<T extends Record<string, any>>(
    entries: T[],
    table: string,
    accountId: string,
    syncTimestamp?: string,
    upsertOptions?: RawJsonUpsertOptions
  ): Promise<T[]>
  upsertMany<T extends Record<string, any>>(entries: T[], table: string): Promise<T[]>
  findMissingEntries(table: string, ids: string[]): Promise<string[]>

  // Account management - required for all database types
  upsertAccount(account: { id: string; raw_data: any }, apiKeyHash: string): Promise<void>
  getAccountByApiKeyHash(apiKeyHash: string): Promise<any | null>
  getAccountIdByApiKeyHash(apiKeyHash: string): Promise<string | null>
  getAllAccounts(): Promise<any[]>

  // Cursor management - matches PostgresClient signature
  // In PostgresClient this updates _sync_obj_runs
  // In DuckDBSyncClient this updates stripe__cursors (ignoring runStartedAt)
  updateObjectCursor(
    accountId: string,
    runStartedAt: Date,
    objectType: string,
    cursor: string | null
  ): Promise<void>
  getLastCompletedCursor(accountId: string, objectType: string): Promise<string | null>

  // Advisory locks (PostgreSQL-only, no-op for others)
  acquireAdvisoryLock(key: string): Promise<void>
  releaseAdvisoryLock(key: string): Promise<void>
  withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T>

  // Sync run observability (PostgreSQL-only, returns null/no-op for others)
  getOrCreateSyncRun(accountId: string, triggeredBy?: string): Promise<any>
  getActiveSyncRun(accountId: string): Promise<any>
  getSyncRun(accountId: string, runStartedAt: Date): Promise<any>
  closeSyncRun(accountId: string, runStartedAt: Date): Promise<void>
  createObjectRuns(accountId: string, runStartedAt: Date, objects: string[]): Promise<void>
  tryStartObjectSync(accountId: string, runStartedAt: Date, object: string): Promise<boolean>
  getObjectRun(accountId: string, runStartedAt: Date, object: string): Promise<any>
  incrementObjectProgress(
    accountId: string,
    runStartedAt: Date,
    object: string,
    count: number
  ): Promise<void>
  updateObjectPageCursor(
    accountId: string,
    runStartedAt: Date,
    object: string,
    cursor: string | null
  ): Promise<void>
  clearObjectPageCursor(accountId: string, runStartedAt: Date, object: string): Promise<void>
  getLastCursorBeforeRun(
    accountId: string,
    object: string,
    runStartedAt: Date
  ): Promise<string | null>
  deleteSyncRuns(accountId: string): Promise<void>
  completeObjectSync(accountId: string, runStartedAt: Date, object: string): Promise<void>
  failObjectSync(
    accountId: string,
    runStartedAt: Date,
    object: string,
    error: string
  ): Promise<void>
  hasAnyObjectErrors(accountId: string, runStartedAt: Date): Promise<boolean>
  countRunningObjects(accountId: string, runStartedAt: Date): Promise<number>
  getNextPendingObject(accountId: string, runStartedAt: Date): Promise<string | null>
  areAllObjectsComplete(accountId: string, runStartedAt: Date): Promise<boolean>
  cancelStaleRuns(accountId: string): Promise<void>

  // Account deletion (PostgreSQL returns counts, DuckDB throws)
  deleteAccountWithCascade(
    accountId: string,
    useTransaction: boolean
  ): Promise<{ [tableName: string]: number }>
  getAccountRecordCounts(accountId: string): Promise<{ [tableName: string]: number }>

  // Pool interface for direct access
  readonly pool: {
    query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>
    end?: () => Promise<void>
  }
}

/**
 * Database types supported by the sync engine
 */
export type DatabaseType = 'postgres' | 'duckdb' | 'sqlite' | 'mysql'

/**
 * Check if a feature is supported by the database type
 */
export function isDatabaseFeatureSupported(
  databaseType: DatabaseType,
  feature: 'syncObservability' | 'advisoryLocks' | 'managedWebhooks'
): boolean {
  // Only PostgreSQL supports these advanced features
  // DuckDB, SQLite, and MySQL only support core sync operations
  return databaseType === 'postgres'
}
