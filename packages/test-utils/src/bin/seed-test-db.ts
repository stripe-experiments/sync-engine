#!/usr/bin/env node
import { seedTestDb } from '../seed/seedTestDb.js'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const summary = await seedTestDb({
    stripeMockUrl: args['stripe-mock-url'],
    postgresUrl: args['postgres-url'],
    schema: args.schema,
    apiVersion: args['api-version'],
    openApiSpecPath: args['openapi-spec-path'],
    count: args.count ? Number(args.count) : undefined,
    limitPerEndpoint: args['limit-per-endpoint'] ? Number(args['limit-per-endpoint']) : undefined,
    tables: args.table ? args.table.split(',').map((value) => value.trim()) : undefined,
    globalFilters: parseFilters(args.filter),
    createdStart: args['created-start'],
    createdEnd: args['created-end'],
  })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = next
    i += 1
  }
  return parsed
}

function parseFilters(filterArg: string | undefined): Record<string, string> | undefined {
  if (!filterArg) return undefined
  const filters: Record<string, string> = {}
  for (const pair of filterArg.split(',')) {
    const [rawKey, ...rest] = pair.split('=')
    const key = rawKey?.trim()
    const value = rest.join('=').trim()
    if (!key || value.length === 0) continue
    filters[key] = value
  }
  return Object.keys(filters).length > 0 ? filters : undefined
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`sync-test-utils seeding failed: ${message}\n`)
  process.exit(1)
})
