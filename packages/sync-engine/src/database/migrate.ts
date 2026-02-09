import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'
import { SIGMA_INGESTION_CONFIGS } from '../sigma/sigmaIngestionConfigs'
import type { SigmaIngestionConfig } from '../sigma/sigmaIngestion'
import {
  createOpenAPIParser,
  createTypeMapper,
  createTableGenerator,
  type OpenAPIParser,
  type TypeMapper,
  type TableGenerator,
} from '../openapi'

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SIGMA_BASE_COLUMNS = ['_raw_data', '_last_synced_at', '_updated_at', '_account_id'] as const
// Postgres identifiers are capped at 63 bytes; long Sigma column names can collide after truncation.
const PG_IDENTIFIER_MAX_BYTES = 63
const SIGMA_COLUMN_HASH_PREFIX = '_h'
const SIGMA_COLUMN_HASH_BYTES = 8

type MigrationConfig = {
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
  enableSigma?: boolean

  // NEW: OpenAPI-based schema generation
  openApiSpecPath?: string        // Path to spec file
  stripeObjects?: string[]        // Objects to create tables for
  schemaName?: string            // Default: 'stripe'
}

function truncateIdentifier(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name
  return Buffer.from(name).subarray(0, maxBytes).toString('utf8')
}

function buildColumnHashSuffix(name: string): string {
  const hash = createHash('sha1').update(name).digest('hex').slice(0, SIGMA_COLUMN_HASH_BYTES)
  return `${SIGMA_COLUMN_HASH_PREFIX}${hash}`
}

function ensureUniqueIdentifier(name: string, used: Set<string>): string {
  const truncated = truncateIdentifier(name, PG_IDENTIFIER_MAX_BYTES)
  if (!used.has(truncated)) {
    return truncated
  }

  const baseSuffix = buildColumnHashSuffix(name)
  for (let counter = 0; counter < 10_000; counter += 1) {
    const suffix = counter === 0 ? baseSuffix : `${baseSuffix}_${counter}`
    const maxBaseBytes = PG_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix)
    if (maxBaseBytes <= 0) {
      throw new Error(`Unable to generate safe column name for ${name}: suffix too long`)
    }
    const base = truncateIdentifier(name, maxBaseBytes)
    const candidate = `${base}${suffix}`
    if (!used.has(candidate)) {
      return candidate
    }
  }

  throw new Error(`Unable to generate unique column name for ${name}`)
}

function buildSigmaGeneratedColumnNameMap(
  columnNames: string[],
  reserved: Set<string>
): Map<string, string> {
  const used = new Set<string>()
  for (const name of reserved) {
    used.add(truncateIdentifier(name, PG_IDENTIFIER_MAX_BYTES))
  }
  const map = new Map<string, string>()
  for (const name of columnNames) {
    const safeName = ensureUniqueIdentifier(name, used)
    map.set(name, safeName)
    used.add(safeName)
  }
  return map
}

function getSigmaColumnMappings(config: SigmaIngestionConfig) {
  const extraColumnNames = config.upsert.extraColumns?.map((c) => c.column) ?? []
  const extraColumnSet = new Set(extraColumnNames)
  const generatedColumns = (config.columns ?? []).filter((c) => !extraColumnSet.has(c.name))
  const reserved = new Set<string>([...SIGMA_BASE_COLUMNS, ...extraColumnNames])
  const generatedNameMap = buildSigmaGeneratedColumnNameMap(
    generatedColumns.map((c) => c.name),
    reserved
  )

  return {
    extraColumnNames,
    generatedColumns,
    generatedNameMap,
  }
}

async function doesTableExist(client: Client, schema: string, tableName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_name = $2
    )`,
    [schema, tableName]
  )
  return result.rows[0]?.exists || false
}

async function renameMigrationsTableIfNeeded(
  client: Client,
  schema = 'stripe',
  logger?: Logger
): Promise<void> {
  const oldTableExists = await doesTableExist(client, schema, 'migrations')
  const newTableExists = await doesTableExist(client, schema, '_migrations')

  if (oldTableExists && !newTableExists) {
    logger?.info('Renaming migrations table to _migrations')
    await client.query(`ALTER TABLE "${schema}"."migrations" RENAME TO "_migrations"`)
    logger?.info('Successfully renamed migrations table')
  }
}

async function cleanupSchema(client: Client, schema: string, logger?: Logger): Promise<void> {
  logger?.warn(`Migrations table is empty - dropping and recreating schema "${schema}"`)
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.query(`CREATE SCHEMA "${schema}"`)
  logger?.info(`Schema "${schema}" has been reset`)
}

async function connectAndMigrate(
  client: Client,
  migrationsDirectory: string,
  config: MigrationConfig,
  logOnError = false
) {
  if (!fs.existsSync(migrationsDirectory)) {
    config.logger?.info(`Migrations directory ${migrationsDirectory} not found, skipping`)
    return
  }

  const optionalConfig = {
    schemaName: 'stripe',
    tableName: '_migrations',
  }

  try {
    await migrate({ client }, migrationsDirectory, optionalConfig)
  } catch (error) {
    if (logOnError && error instanceof Error) {
      config.logger?.error(error, 'Migration error:')
    } else {
      throw error
    }
  }
}

async function fetchTableMetadata(client: Client, schema: string, table: string) {
  // Fetch columns
  const colsResult = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
  `,
    [schema, table]
  )

  // Fetch PK columns
  const pkResult = await client.query(
    `
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass
    AND i.indisprimary
  `,
    [`"${schema}"."${table}"`]
  )

  return {
    columns: colsResult.rows.map((r) => r.column_name),
    pk: pkResult.rows.map((r) => r.attname),
  }
}

function shouldRecreateTable(
  current: { columns: string[]; pk: string[] },
  expectedCols: string[],
  expectedPk: string[]
): boolean {
  // Compare PKs
  const pkMatch =
    current.pk.length === expectedPk.length && expectedPk.every((p) => current.pk.includes(p))
  if (!pkMatch) return true

  // Compare columns
  const allExpected = [...new Set([...SIGMA_BASE_COLUMNS, ...expectedCols])]

  if (current.columns.length !== allExpected.length) return true
  return allExpected.every((c) => current.columns.includes(c))
}

async function ensureSigmaTableMetadata(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig
): Promise<void> {
  const tableName = config.destinationTable

  // 1. Foreign key to stripe.accounts
  const fkName = `fk_${tableName}_account`
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    DROP CONSTRAINT IF EXISTS "${fkName}";
  `)
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    ADD CONSTRAINT "${fkName}"
    FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
  `)

  // 2. Updated at trigger
  await client.query(`
    DROP TRIGGER IF EXISTS handle_updated_at ON "${schema}"."${tableName}";
  `)
  await client.query(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "${schema}"."${tableName}"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `)
}

async function createSigmaTable(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig
): Promise<void> {
  const tableName = config.destinationTable
  const { generatedColumns, generatedNameMap } = getSigmaColumnMappings(config)
  const pk = config.upsert.conflictTarget.map((c) => generatedNameMap.get(c) ?? c)

  const columnDefs = [
    '"_raw_data" jsonb NOT NULL',
    '"_last_synced_at" timestamptz',
    '"_updated_at" timestamptz DEFAULT now()',
    '"_account_id" text NOT NULL',
  ]

  // Explicit columns
  for (const col of config.upsert.extraColumns ?? []) {
    columnDefs.push(`"${col.column}" ${col.pgType} NOT NULL`)
  }

  // Generated columns
  for (const col of generatedColumns) {
    // For temporal types in generated columns, use text to avoid immutability errors
    const isTemporal =
      col.pgType === 'timestamptz' || col.pgType === 'date' || col.pgType === 'timestamp'
    const pgType = isTemporal ? 'text' : col.pgType
    const safeName = generatedNameMap.get(col.name) ?? col.name

    columnDefs.push(
      `"${safeName}" ${pgType} GENERATED ALWAYS AS ((NULLIF(_raw_data->>'${col.name}', ''))::${pgType}) STORED`
    )
  }

  const sql = `
    CREATE TABLE "${schema}"."${tableName}" (
      ${columnDefs.join(',\n      ')},
      PRIMARY KEY (${pk.map((c) => `"${c}"`).join(', ')})
    );
  `
  await client.query(sql)
  await ensureSigmaTableMetadata(client, schema, config)
}

async function migrateSigmaSchema(
  client: Client,
  config: MigrationConfig,
  sigmaSchemaName = 'sigma'
): Promise<void> {
  config.logger?.info(`Reconciling Sigma schema "${sigmaSchemaName}"`)

  await client.query(`CREATE SCHEMA IF NOT EXISTS "${sigmaSchemaName}"`)

  for (const [key, tableConfig] of Object.entries(SIGMA_INGESTION_CONFIGS)) {
    if (!tableConfig.columns) {
      config.logger?.info(`Skipping Sigma table ${key} - no column metadata`)
      continue
    }

    const tableName = tableConfig.destinationTable
    const tableExists = await doesTableExist(client, sigmaSchemaName, tableName)

    const { extraColumnNames, generatedColumns, generatedNameMap } =
      getSigmaColumnMappings(tableConfig)
    const expectedCols = [
      ...extraColumnNames,
      ...generatedColumns.map((c) => generatedNameMap.get(c.name) ?? c.name),
    ]
    const expectedPk = tableConfig.upsert.conflictTarget.map((c) => generatedNameMap.get(c) ?? c)

    if (tableExists) {
      const metadata = await fetchTableMetadata(client, sigmaSchemaName, tableName)
      if (shouldRecreateTable(metadata, expectedCols, expectedPk)) {
        config.logger?.warn(
          `Schema mismatch for ${sigmaSchemaName}.${tableName} - dropping and recreating`
        )
        await client.query(`DROP TABLE "${sigmaSchemaName}"."${tableName}" CASCADE`)
        await createSigmaTable(client, sigmaSchemaName, tableConfig)
      } else {
        await ensureSigmaTableMetadata(client, sigmaSchemaName, tableConfig)
      }
    } else {
      config.logger?.info(`Creating Sigma table ${sigmaSchemaName}.${tableName}`)
      await createSigmaTable(client, sigmaSchemaName, tableConfig)
    }
  }
}

async function getTableColumns(client: Client, schema: string, tableName: string): Promise<string[]> {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, tableName]
  )
  return result.rows.map(row => row.column_name)
}

async function migrateOpenAPISchema(
  client: Client,
  config: MigrationConfig,
  schemaName = 'stripe'
): Promise<void> {
  if (!config.openApiSpecPath || !config.stripeObjects || config.stripeObjects.length === 0) {
    config.logger?.info('No OpenAPI configuration provided, skipping OpenAPI-based migrations')
    return
  }

  config.logger?.info(`Running OpenAPI-based migrations for schema "${schemaName}"`)

  // Validate spec file exists
  if (!fs.existsSync(config.openApiSpecPath)) {
    throw new Error(`OpenAPI spec file not found: ${config.openApiSpecPath}`)
  }

  // Initialize OpenAPI components
  const parser = createOpenAPIParser()
  const typeMapper = createTypeMapper()
  const tableGenerator = createTableGenerator(parser, typeMapper)

  try {
    // Load the OpenAPI spec
    await parser.loadSpec(config.openApiSpecPath)
    const apiVersion = parser.getApiVersion()
    config.logger?.info(`Loaded OpenAPI spec version: ${apiVersion}`)

    // Ensure schema exists
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)

    // Validate that all specified objects exist in the spec
    const availableObjects = parser.listObjectTypes()
    const availableObjectSet = new Set(availableObjects)

    for (const objectName of config.stripeObjects) {
      if (!availableObjectSet.has(objectName)) {
        throw new Error(
          `Object '${objectName}' not found in OpenAPI spec. Available objects: ${availableObjects.join(', ')}`
        )
      }
    }

    // Process each configured Stripe object
    for (const objectName of config.stripeObjects) {
      const tableName = tableGenerator.getTableName(objectName)
      const tableExists = await doesTableExist(client, schemaName, tableName)

      if (tableExists) {
        // Check for schema evolution (new columns)
        const existingColumns = await getTableColumns(client, schemaName, tableName)
        const alterStatements = tableGenerator.generateSchemaEvolution(
          objectName,
          existingColumns,
          schemaName
        )

        if (alterStatements.length > 0) {
          config.logger?.info(
            `Evolving schema for ${schemaName}.${tableName}: adding ${alterStatements.length} new columns`
          )
          for (const statement of alterStatements) {
            await client.query(statement)
            config.logger?.info(`Executed: ${statement}`)
          }
        } else {
          config.logger?.info(`Table ${schemaName}.${tableName} is up to date`)
        }
      } else {
        // Create new table
        config.logger?.info(`Creating table ${schemaName}.${tableName} from OpenAPI spec`)
        const createTableSQL = tableGenerator.generateCreateTable(objectName, schemaName)
        await client.query(createTableSQL)
        config.logger?.info(`Created table ${schemaName}.${tableName}`)
      }
    }

    config.logger?.info('OpenAPI-based migrations completed successfully')
  } catch (error) {
    config.logger?.error(error, 'Error in OpenAPI-based migrations')
    throw error
  }
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  // Init DB
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })

  const schema = 'stripe'

  try {
    // Run migrations
    await client.connect()

    // Ensure schema exists, not doing it via migration to not break current migration checksums
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};`)

    // Rename old migrations table if it exists (one-time upgrade to internal table naming convention)
    await renameMigrationsTableIfNeeded(client, schema, config.logger)

    // Check if migrations table is empty and cleanup if needed
    const tableExists = await doesTableExist(client, schema, '_migrations')
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${schema}"."_migrations"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, schema, config.logger)
      }
    }

    config.logger?.info('Running migrations')

    await connectAndMigrate(client, path.resolve(__dirname, './migrations'), config)

    // Run Sigma dynamic migrations after core migrations (only if sigma is enabled)
    if (config.enableSigma) {
      await migrateSigmaSchema(client, config)
    }

    // Run OpenAPI-based migrations after core migrations
    await migrateOpenAPISchema(client, config, config.schemaName)
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}
