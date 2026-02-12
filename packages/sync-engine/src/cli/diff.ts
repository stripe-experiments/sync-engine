/**
 * CLI Command: diff-schema
 *
 * Compare database schema with OpenAPI-generated schema and report differences.
 */

import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import { PostgresClient } from '../database/postgres'
import { createDatabaseIntrospector } from '../database/introspection'
import { createOpenAPIParser } from '../openapi/parser'
import { createTypeMapper } from '../openapi/typeMapper'
import { createTableGenerator } from '../openapi/tableGenerator'
import { createSchemaDiffer, type SchemaDiff, type SchemaComparisonResult } from '../openapi/schemaDiffer'

export interface DiffSchemaOptions {
  /** Path to OpenAPI spec file */
  spec: string

  /** Database URL */
  databaseUrl: string

  /** Stripe objects to compare (comma-separated) */
  objects?: string

  /** Database schema name */
  schema?: string

  /** Output format */
  format?: 'text' | 'json'

  /** Generate migration script */
  generateMigration?: boolean

  /** Output file for migration script */
  output?: string

  /** Validate only mode (exit code based) */
  validateOnly?: boolean

  /** Whether to suggest indexes */
  suggestIndexes?: boolean
}

/**
 * Main diff-schema command implementation
 */
export async function diffSchemaCommand(options: DiffSchemaOptions): Promise<void> {
  try {
    const {
      spec,
      databaseUrl,
      objects,
      schema = 'stripe',
      format = 'text',
      generateMigration = false,
      output,
      validateOnly = false,
      suggestIndexes = true,
    } = options

    // Validate required options
    if (!spec) {
      throw new Error('OpenAPI spec path is required (--spec)')
    }

    if (!databaseUrl) {
      throw new Error('Database URL is required (--database-url)')
    }

    // Check if spec file exists
    try {
      await fs.access(spec)
    } catch {
      throw new Error(`OpenAPI spec file not found: ${spec}`)
    }

    // Parse objects list
    const objectList = objects ? objects.split(',').map(s => s.trim()) : getDefaultObjects()

    if (objectList.length === 0) {
      throw new Error('No objects specified for comparison')
    }

    // Initialize components
    const postgresClient = new PostgresClient({
      schema,
      poolConfig: { connectionString: databaseUrl },
    })

    const introspector = createDatabaseIntrospector(postgresClient)
    const parser = createOpenAPIParser()
    const typeMapper = createTypeMapper()
    const tableGenerator = createTableGenerator(parser, typeMapper)
    const differ = createSchemaDiffer(parser, typeMapper, tableGenerator, introspector)

    // Perform schema comparison
    console.log(chalk.blue('Comparing database schema with OpenAPI specification...'))
    console.log(`OpenAPI spec: ${spec}`)
    console.log(`Database: ${databaseUrl}`)
    console.log(`Schema: ${schema}`)
    console.log(`Objects: ${objectList.join(', ')}`)
    console.log()

    const result = await differ.compareSchemas({
      databaseUrl,
      openApiSpecPath: spec,
      objects: objectList,
      schema,
      suggestIndexes,
    })

    // Handle different output modes
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      await outputTextReport(result)
    }

    // Generate migration script if requested
    if (generateMigration) {
      const migrationScript = differ.generateMigrationScript(result.diffs, schema)

      if (output) {
        await fs.writeFile(output, migrationScript)
        console.log(chalk.green(`\nMigration script written to: ${output}`))
      } else {
        console.log('\n' + chalk.yellow('Migration Script:'))
        console.log('='.repeat(50))
        console.log(migrationScript)
      }
    }

    // Handle validate-only mode
    if (validateOnly) {
      const hasIssues = result.summary.differentTables > 0 || result.summary.missingTables > 0
      if (hasIssues) {
        console.error(chalk.red('\nSchema validation failed: differences detected'))
        process.exit(1)
      } else {
        console.log(chalk.green('\nSchema validation passed: no differences detected'))
        process.exit(0)
      }
    }

    // Close database connection
    await postgresClient.pool.end()

  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

/**
 * Output text-based comparison report
 */
async function outputTextReport(result: SchemaComparisonResult): Promise<void> {
  console.log(chalk.bold('Schema Comparison Report'))
  console.log('='.repeat(25))
  console.log(`API Version: ${result.apiVersion}`)
  console.log(`Timestamp: ${result.timestamp}`)
  console.log()

  // Summary
  console.log(chalk.bold('Summary:'))
  console.log(`Total tables: ${result.summary.totalTables}`)
  console.log(`${chalk.green('✓')} Up to date: ${result.summary.identicalTables}`)

  if (result.summary.differentTables > 0) {
    console.log(`${chalk.yellow('✗')} Differences found: ${result.summary.differentTables}`)
  }

  if (result.summary.missingTables > 0) {
    console.log(`${chalk.red('⚠')} Missing tables: ${result.summary.missingTables}`)
  }

  if (result.summary.extraTables > 0) {
    console.log(`${chalk.cyan('i')} Extra tables: ${result.summary.extraTables}`)
  }

  console.log()

  // Detailed results
  for (const diff of result.diffs) {
    await outputTableDiff(diff)
  }

  // Index recommendations
  const allIndexSuggestions = result.diffs.flatMap(d => d.suggestedIndexes)
  if (allIndexSuggestions.length > 0) {
    console.log(chalk.bold('Indexing Recommendations:'))
    for (const suggestion of allIndexSuggestions) {
      console.log(`- ${suggestion.sql}`)
    }
    console.log()
  }
}

/**
 * Output details for a single table comparison
 */
async function outputTableDiff(diff: SchemaDiff): Promise<void> {
  const { tableName, status } = diff

  switch (status) {
    case 'identical':
      console.log(`${chalk.green('✓')} ${tableName}: Up to date`)
      break

    case 'missing':
      console.log(`${chalk.red('⚠')} ${tableName}: Missing table`)
      console.log(`  ${chalk.dim('→ Run migration to create table')}`)
      break

    case 'extra':
      console.log(`${chalk.cyan('i')} ${tableName}: Extra table (not in OpenAPI spec)`)
      break

    case 'different':
      console.log(`${chalk.yellow('✗')} ${tableName}: Differences found`)

      // Show columns to add
      if (diff.columnsToAdd.length > 0) {
        for (const column of diff.columnsToAdd) {
          const nullable = column.nullable ? ', nullable' : ''
          console.log(`  ${chalk.green('+')} Add column: ${column.name} (${column.type}${nullable})`)
        }
      }

      // Show columns to remove
      if (diff.columnsToRemove.length > 0) {
        for (const column of diff.columnsToRemove) {
          console.log(`  ${chalk.red('-')} Remove column: ${column.name} (not in OpenAPI spec)`)
        }
      }

      // Show columns to modify
      if (diff.columnsToModify.length > 0) {
        for (const mod of diff.columnsToModify) {
          const safetyIndicator = mod.isSafe ? chalk.yellow('~') : chalk.red('!')
          console.log(`  ${safetyIndicator} Modify column: ${mod.name} (${mod.reason})`)
        }
      }
      break
  }

  console.log()
}

/**
 * Get default Stripe objects to compare
 */
function getDefaultObjects(): string[] {
  return [
    'customer',
    'charge',
    'payment_intent',
    'subscription',
    'invoice',
    'product',
    'price',
    'payment_method',
  ]
}

/**
 * Validate CLI options
 */
export function validateDiffOptions(options: Partial<DiffSchemaOptions>): string[] {
  const errors: string[] = []

  if (!options.spec) {
    errors.push('OpenAPI spec path is required (--spec)')
  }

  if (!options.databaseUrl) {
    errors.push('Database URL is required (--database-url)')
  }

  if (options.format && !['text', 'json'].includes(options.format)) {
    errors.push('Format must be "text" or "json"')
  }

  if (options.generateMigration && options.validateOnly) {
    errors.push('Cannot use --generate-migration with --validate-only')
  }

  return errors
}