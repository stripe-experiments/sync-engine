import { execSync } from 'node:child_process'
import pg from 'pg'

export type DockerPostgres18Handle = {
  containerId: string
  hostPort: number
  connectionString: string
  stop: () => void
}

export async function startDockerPostgres18(): Promise<DockerPostgres18Handle> {
  try {
    execSync('docker info', { stdio: 'ignore' })
  } catch {
    throw new Error('Docker is not running. Start Docker and try again.')
  }

  let containerId: string
  try {
    containerId = execSync(
      [
        'docker run -d -p 0:5432',
        '-e POSTGRES_PASSWORD=postgres',
        '-e POSTGRES_DB=postgres',
        'postgres:18',
        '-c ssl=on',
        '-c ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem',
        '-c ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key',
      ].join(' '),
      { encoding: 'utf8' }
    ).trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to start postgres:18 container: ${msg}`)
  }

  const hostPortValue = execSync(`docker port ${containerId} 5432`, {
    encoding: 'utf8',
  })
    .trim()
    .split(':')
    .pop()

  if (!hostPortValue) {
    stopContainer(containerId)
    throw new Error(`Failed to determine mapped host port for postgres container ${containerId}`)
  }
  const hostPort = Number(hostPortValue)
  if (!Number.isFinite(hostPort)) {
    stopContainer(containerId)
    throw new Error(`Invalid mapped host port "${hostPortValue}" for postgres container ${containerId}`)
  }

  const connectionString = `postgresql://postgres:postgres@localhost:${hostPort}/postgres`
  await waitForPostgres(connectionString)

  return {
    containerId,
    hostPort,
    connectionString,
    stop: () => stopContainer(containerId),
  }
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString })
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await pool.query('SELECT 1')
        return
      } catch {
        await sleep(500)
      }
    }
    throw new Error('Postgres container did not become ready in time')
  } finally {
    await pool.end().catch(() => undefined)
  }
}

function stopContainer(containerId: string): void {
  try {
    execSync(`docker rm -f ${containerId}`, { stdio: 'ignore' })
  } catch {
    // Ignore cleanup errors.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
