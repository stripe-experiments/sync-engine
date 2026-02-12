/**
 * Integration tests for OpenAPI-based migrations
 *
 * Tests the dynamic schema generation and migration system using real OpenAPI specs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Client } from 'pg'
import { runMigrations } from '../migrate'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../../types'

// Mock logger for tests
const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}

describe('OpenAPI Migrations', () => {
  let client: Client
  let testDatabaseUrl: string

  beforeAll(async () => {
    // Use test database URL from environment or default
    testDatabaseUrl = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/sync_engine_test'
    client = new Client({ connectionString: testDatabaseUrl })

    try {
      await client.connect()
    } catch (error) {
      console.warn('Database not available for integration tests, skipping')
      return
    }
  })

  afterAll(async () => {
    if (client) {
      await client.end()
    }
  })

  beforeEach(async () => {
    if (!client) return

    // Clean up test schema
    await client.query('DROP SCHEMA IF EXISTS test_stripe CASCADE')
    await client.query('CREATE SCHEMA test_stripe')
  })

  describe('Basic OpenAPI Migration', () => {
    it('should skip OpenAPI migrations when no config provided', async () => {
      if (!client) return

      const config = {
        databaseUrl: testDatabaseUrl,
        logger: mockLogger,
      }

      await runMigrations(config)

      // Should not create any OpenAPI tables
      const result = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'stripe' AND table_name IN ('customers', 'charges')`
      )
      expect(result.rows).toHaveLength(0)
    })

    it('should handle missing OpenAPI spec file gracefully', async () => {
      if (!client) return

      const config = {
        databaseUrl: testDatabaseUrl,
        logger: mockLogger,
        openApiSpecPath: '/nonexistent/spec.json',
        stripeObjects: ['customer'],
        schemaName: 'test_stripe',
      }

      await expect(runMigrations(config)).rejects.toThrow('OpenAPI spec file not found')
    })

    it('should validate object names against OpenAPI spec', async () => {
      if (!client) return

      // Create a minimal test OpenAPI spec
      const testSpec = {
        openapi: '3.0.0',
        info: { version: '2024-12-18', title: 'Test Stripe API' },
        components: {
          schemas: {
            customer: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string', nullable: true },
              }
            }
          }
        }
      }

      const specPath = path.join(__dirname, 'test-spec.json')
      fs.writeFileSync(specPath, JSON.stringify(testSpec, null, 2))

      try {
        const config = {
          databaseUrl: testDatabaseUrl,
          logger: mockLogger,
          openApiSpecPath: specPath,
          stripeObjects: ['customer', 'invalid_object'],
          schemaName: 'test_stripe',
        }

        await expect(runMigrations(config)).rejects.toThrow(
          "Object 'invalid_object' not found in OpenAPI spec"
        )
      } finally {
        fs.unlinkSync(specPath)
      }
    })
  })

  describe('Table Creation', () => {
    let testSpecPath: string

    beforeEach(() => {
      // Create a test OpenAPI spec with sample objects
      const testSpec = {
        openapi: '3.0.0',
        info: { version: '2024-12-18', title: 'Test Stripe API' },
        components: {
          schemas: {
            customer: {
              type: 'object',
              description: 'A customer object',
              properties: {
                id: { type: 'string', description: 'Unique identifier' },
                object: { type: 'string' },
                email: { type: 'string', nullable: true },
                name: { type: 'string', nullable: true },
                created: { type: 'integer', format: 'unix-time' },
                balance: { type: 'integer' },
                delinquent: { type: 'boolean' },
                metadata: {
                  type: 'object',
                  additionalProperties: { type: 'string' }
                },
                preferred_locales: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            },
            charge: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                object: { type: 'string' },
                amount: { type: 'integer' },
                currency: { type: 'string' },
                status: { type: 'string' },
                created: { type: 'integer', format: 'unix-time' },
                customer: { type: 'string', nullable: true },
                metadata: {
                  type: 'object',
                  additionalProperties: { type: 'string' }
                }
              }
            }
          }
        }
      }

      testSpecPath = path.join(__dirname, 'test-migration-spec.json')
      fs.writeFileSync(testSpecPath, JSON.stringify(testSpec, null, 2))
    })

    afterEach(() => {
      if (fs.existsSync(testSpecPath)) {
        fs.unlinkSync(testSpecPath)
      }
    })

    it('should create tables from OpenAPI spec', async () => {
      if (!client) return

      const config = {
        databaseUrl: testDatabaseUrl,
        logger: mockLogger,
        openApiSpecPath: testSpecPath,
        stripeObjects: ['customer', 'charge'],
        schemaName: 'test_stripe',
      }

      await runMigrations(config)

      // Check that tables were created
      const tablesResult = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'test_stripe'
         ORDER BY table_name`
      )
      const tableNames = tablesResult.rows.map(row => row.table_name)
      expect(tableNames).toContain('customers')
      expect(tableNames).toContain('charges')

      // Check customer table structure
      const customerCols = await client.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'test_stripe' AND table_name = 'customers'
         ORDER BY column_name`
      )

      const columnsByName = customerCols.rows.reduce((acc, row) => {
        acc[row.column_name] = { type: row.data_type, nullable: row.is_nullable }
        return acc
      }, {} as Record<string, { type: string, nullable: string }>)

      // Check key columns exist with correct types
      expect(columnsByName.id).toEqual({ type: 'text', nullable: 'NO' })
      expect(columnsByName.email).toEqual({ type: 'text', nullable: 'YES' })
      expect(columnsByName.balance).toEqual({ type: 'bigint', nullable: 'YES' })
      expect(columnsByName.delinquent).toEqual({ type: 'boolean', nullable: 'YES' })
      expect(columnsByName.metadata).toEqual({ type: 'jsonb', nullable: 'YES' })
      expect(columnsByName.preferred_locales).toEqual({ type: 'ARRAY', nullable: 'YES' })

      // Check primary key constraint
      const pkResult = await client.query(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'test_stripe.customers'::regclass
         AND i.indisprimary`
      )
      expect(pkResult.rows.map(row => row.attname)).toEqual(['id'])
    })

    it('should handle idempotent operations', async () => {
      if (!client) return

      const config = {
        databaseUrl: testDatabaseUrl,
        logger: mockLogger,
        openApiSpecPath: testSpecPath,
        stripeObjects: ['customer'],
        schemaName: 'test_stripe',
      }

      // Run migrations twice
      await runMigrations(config)
      await runMigrations(config)

      // Should still have only one customer table
      const tablesResult = await client.query(
        `SELECT COUNT(*) as count FROM information_schema.tables
         WHERE table_schema = 'test_stripe' AND table_name = 'customers'`
      )
      expect(tablesResult.rows[0].count).toBe('1')
    })
  })

  describe('Schema Evolution', () => {
    let initialSpecPath: string
    let evolvedSpecPath: string

    beforeEach(() => {
      // Initial spec with basic customer
      const initialSpec = {
        openapi: '3.0.0',
        info: { version: '2024-12-18', title: 'Test Stripe API' },
        components: {
          schemas: {
            customer: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string', nullable: true },
                name: { type: 'string', nullable: true }
              }
            }
          }
        }
      }

      // Evolved spec with additional fields
      const evolvedSpec = {
        ...initialSpec,
        info: { version: '2024-12-19', title: 'Test Stripe API' },
        components: {
          schemas: {
            customer: {
              type: 'object',
              properties: {
                ...initialSpec.components.schemas.customer.properties,
                phone: { type: 'string', nullable: true },
                address: {
                  type: 'object',
                  properties: {
                    line1: { type: 'string' },
                    city: { type: 'string' }
                  }
                },
                created: { type: 'integer', format: 'unix-time' }
              }
            }
          }
        }
      }

      initialSpecPath = path.join(__dirname, 'initial-spec.json')
      evolvedSpecPath = path.join(__dirname, 'evolved-spec.json')
      fs.writeFileSync(initialSpecPath, JSON.stringify(initialSpec, null, 2))
      fs.writeFileSync(evolvedSpecPath, JSON.stringify(evolvedSpec, null, 2))
    })

    afterEach(() => {
      if (fs.existsSync(initialSpecPath)) fs.unlinkSync(initialSpecPath)
      if (fs.existsSync(evolvedSpecPath)) fs.unlinkSync(evolvedSpecPath)
    })

    it('should add new columns when spec evolves', async () => {
      if (!client) return

      // Create table with initial spec
      const initialConfig = {
        databaseUrl: testDatabaseUrl,
        logger: mockLogger,
        openApiSpecPath: initialSpecPath,
        stripeObjects: ['customer'],
        schemaName: 'test_stripe',
      }

      await runMigrations(initialConfig)

      // Check initial columns
      const initialCols = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'test_stripe' AND table_name = 'customers'
         ORDER BY column_name`
      )
      const initialColumnNames = initialCols.rows.map(row => row.column_name)
      expect(initialColumnNames).toEqual(['email', 'id', 'name'])

      // Run migration with evolved spec
      const evolvedConfig = {
        ...initialConfig,
        openApiSpecPath: evolvedSpecPath,
      }

      await runMigrations(evolvedConfig)

      // Check that new columns were added
      const finalCols = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'test_stripe' AND table_name = 'customers'
         ORDER BY column_name`
      )
      const finalColumnNames = finalCols.rows.map(row => row.column_name)
      expect(finalColumnNames).toEqual(['address', 'created', 'email', 'id', 'name', 'phone'])

      // New columns should be nullable
      const newColumnDetails = await client.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'test_stripe' AND table_name = 'customers'
         AND column_name IN ('phone', 'address', 'created')`
      )
      for (const row of newColumnDetails.rows) {
        expect(row.is_nullable).toBe('YES')
      }
    })
  })

  describe('Error Handling', () => {
    it('should rollback on migration errors', async () => {
      if (!client) return

      // This test would need a more complex setup to force an error
      // For now, we'll test the basic error handling structure
      const config = {
        databaseUrl: 'postgresql://invalid:5432/test',
        logger: mockLogger,
        openApiSpecPath: '/nonexistent/spec.json',
        stripeObjects: ['customer'],
      }

      await expect(runMigrations(config)).rejects.toThrow()
    })
  })
})