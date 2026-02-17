/**
 * Docker PostgreSQL setup for integration tests
 */
import { execSync } from 'child_process'
import pg from 'pg'

const { Pool } = pg

export interface TestDbConfig {
  containerName: string
  dbName: string
  port?: number
}

const DEFAULT_PORT = 5432
const POSTGRES_IMAGE = 'postgres:15'

export async function startPostgres(config: TestDbConfig): Promise<pg.Pool> {
  const { containerName, dbName, port = DEFAULT_PORT } = config

  // Stop existing container if running
  try {
    execSync(`docker stop ${containerName} 2>/dev/null || true`, { stdio: 'pipe' })
    execSync(`docker rm ${containerName} 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {
    // Ignore errors
  }

  // Start fresh PostgreSQL container
  execSync(
    `docker run -d --name ${containerName} \
      -e POSTGRES_USER=postgres \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=${dbName} \
      -p ${port}:5432 \
      ${POSTGRES_IMAGE}`,
    { stdio: 'pipe' }
  )

  // Wait for PostgreSQL to be ready
  let retries = 30
  while (retries > 0) {
    try {
      execSync(`docker exec ${containerName} pg_isready -U postgres -d ${dbName}`, {
        stdio: 'pipe',
      })
      break
    } catch {
      retries--
      await sleep(1000)
    }
  }

  if (retries === 0) {
    throw new Error('PostgreSQL failed to start within timeout')
  }

  // Create stripe schema
  execSync(
    `docker exec ${containerName} psql -U postgres -d ${dbName} -c 'CREATE SCHEMA IF NOT EXISTS stripe;'`,
    { stdio: 'pipe' }
  )

  // Return connection pool
  const pool = new Pool({
    connectionString: `postgresql://postgres:postgres@localhost:${port}/${dbName}`,
  })

  return pool
}

export async function stopPostgres(containerName: string): Promise<void> {
  try {
    execSync(`docker stop ${containerName} 2>/dev/null || true`, { stdio: 'pipe' })
    execSync(`docker rm ${containerName} 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {
    // Ignore errors during cleanup
  }
}

export async function queryDb<T = Record<string, unknown>>(
  pool: pg.Pool,
  sql: string
): Promise<T[]> {
  const result = await pool.query(sql)
  return result.rows as T[]
}

export async function queryDbSingle<T = Record<string, unknown>>(
  pool: pg.Pool,
  sql: string
): Promise<T | null> {
  const rows = await queryDb<T>(pool, sql)
  return rows[0] ?? null
}

export async function queryDbCount(
  pool: pg.Pool,
  sql: string,
  params?: unknown[]
): Promise<number> {
  const result = await pool.query(sql, params)
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

export function getDatabaseUrl(port: number, dbName: string): string {
  return `postgresql://postgres:postgres@localhost:${port}/${dbName}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
