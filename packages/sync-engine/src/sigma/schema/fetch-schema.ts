import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import chalk from 'chalk'
import { format } from 'prettier'

type ReportingColumn = {
  name: string
  comment: string
  type: string
  primary_key?: boolean
  foreign_key?: string
}

type ReportingTable = {
  name: string
  comment: string
  columns: Array<ReportingColumn>
  section: string
}

type ReportingDataset = {
  name: string
  tables: Array<ReportingTable>
}

type ReportingSchema = {
  schema: Array<ReportingDataset>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCHEMA_ENDPOINT = 'https://docs.stripe.com/_endpoint/get-reporting-data-schema'
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts')

const OUTPUT_FILE = path.join(ARTIFACTS_DIR, 'schema_artifact.json')
const GENERATED_CONFIG_FILE = path.join(ARTIFACTS_DIR, 'sigmaIngestionConfigs.ts')

function logSection(title: string, lines: string[]) {
  console.log(`\n${chalk.bold.cyan(title)}`)
  for (const line of lines) {
    console.log(`  ${line}`)
  }
}

/**
 * Fetches the reporting data schema from Stripe and saves it as an artifact.
 */
async function fetchSchema() {
  logSection('Fetch Schema', [`Endpoint: ${chalk.gray(SCHEMA_ENDPOINT)}`])

  const response = await fetch(SCHEMA_ENDPOINT)
  if (!response.ok) {
    throw new Error(`Failed to fetch schema: ${response.statusText} (${response.status})`)
  }

  const data = (await response.json()) as ReportingSchema

  await fs.mkdir(ARTIFACTS_DIR, { recursive: true })
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2))

  logSection('Schema Artifact', [`Saved: ${chalk.gray(OUTPUT_FILE)}`])

  return data
}

/**
 * Maps Sigma types to Postgres types.
 */
function mapSigmaTypeToPg(type: string, name: string): string {
  const t = type.toLowerCase()

  if (t.startsWith('varchar')) return 'text'
  if (t.startsWith('decimal')) return t.replace('decimal', 'numeric')

  switch (t) {
    case 'timestamp':
      if (name === 'date' || name.endsWith('_day') || name.endsWith('_date')) return 'date'
      return 'timestamptz'
    case 'bigint':
      return 'bigint'
    case 'double':
      return 'double precision'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'integer':
      return 'integer'
    default:
      return 'text'
  }
}

/**
 * Maps Sigma types to Cursor types.
 */
function mapSigmaTypeToCursor(type: string): 'timestamp' | 'string' | 'number' {
  const t = type.toLowerCase()
  if (t.startsWith('decimal')) return 'number'

  switch (t) {
    case 'timestamp':
      return 'timestamp'
    case 'bigint':
    case 'double':
    case 'integer':
      return 'number'
    default:
      return 'string'
  }
}

/**
 * Generates an ingestion configuration for a single table.
 * Tables without primary keys are skipped for stability.
 */
function buildConfig(table: ReportingTable, pks: ReportingTable['columns']) {
  const PAGE_SIZE_DURING_SYNC = 10_000
  const SYNC_CURSOR_VERSION = 1

  return {
    sigmaTable: table.name,
    destinationTable: table.name,
    pageSize: PAGE_SIZE_DURING_SYNC,
    cursor: {
      version: SYNC_CURSOR_VERSION,
      columns: pks.map((c) => ({
        column: c.name,
        type: mapSigmaTypeToCursor(c.type),
      })),
    },
    columns: table.columns.map((c) => ({
      name: c.name,
      sigmaType: c.type,
      pgType: mapSigmaTypeToPg(c.type, c.name),
      primaryKey: !!c.primary_key,
    })),
    upsert: {
      conflictTarget: ['_account_id', ...pks.map((c) => c.name)],
      extraColumns: pks.map((c) => ({
        column: c.name,
        pgType: mapSigmaTypeToPg(c.type, c.name),
        entryKey: c.name,
      })),
    },
  }
}

/**
 * Iterates over all tables in the schema and writes the generated configs to disk.
 */
async function writeGeneratedConfigs(data: ReportingSchema) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configs: Record<string, any> = {}
  const stats = {
    datasetCount: data.schema.length,
    tableCount: 0,
    processedCount: 0,
    skippedCount: 0,
    totalColumns: 0,
    processedColumns: 0,
    totalPrimaryKeyColumns: 0,
  }

  for (const dataset of data.schema) {
    for (const table of dataset.tables) {
      stats.tableCount += 1
      stats.totalColumns += table.columns.length

      const pks = table.columns.filter((c) => c.primary_key)
      stats.totalPrimaryKeyColumns += pks.length

      if (pks.length === 0) {
        stats.skippedCount += 1
        continue
      }

      stats.processedCount += 1
      stats.processedColumns += table.columns.length

      configs[table.name] = buildConfig(table, pks)
    }
  }

  const sortedConfigs = Object.fromEntries(
    Object.keys(configs)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, configs[key]])
  )

  logSection('Schema Metadata', [
    `Datasets: ${chalk.bold(String(stats.datasetCount))}`,
    `Tables: ${chalk.bold(String(stats.tableCount))}`,
    `Columns (total): ${chalk.bold(String(stats.totalColumns))}`,
    `Primary key columns (total): ${chalk.bold(String(stats.totalPrimaryKeyColumns))}`,
    `Tables processed (with PK): ${chalk.bold(String(stats.processedCount))}`,
    `Tables skipped (no PK): ${chalk.bold(String(stats.skippedCount))}`,
    `Columns processed: ${chalk.bold(String(stats.processedColumns))}`,
  ])

  const content = `// This file is AUTO-GENERATED by fetch-schema.ts
// Do not edit manually. Run 'npm run generate:sigma-schema' to update.

import type { SigmaIngestionConfig } from '../../sigmaIngestion'

export const SIGMA_INGESTION_CONFIGS: Record<string, SigmaIngestionConfig> = ${JSON.stringify(
    sortedConfigs,
    null,
    2
  )}
`

  const formatted = await format(content, {
    parser: 'typescript',
    singleQuote: true,
    trailingComma: 'es5',
    printWidth: 100,
  })

  await fs.writeFile(GENERATED_CONFIG_FILE, formatted)
  logSection('Generated Configs', [
    `Configs written: ${chalk.bold(String(stats.processedCount))}`,
    `Output: ${chalk.gray(GENERATED_CONFIG_FILE)}`,
  ])
}

fetchSchema()
  .then(writeGeneratedConfigs)
  .catch((err) => {
    console.error(chalk.red('Failed to generate Sigma ingestion configs.'))
    console.error(err)
    process.exit(1)
  })
