import { NextRequest, NextResponse } from 'next/server'
import {
  createOpenAPIParser,
  createTypeMapper,
  fetchOpenAPISpec,
  type TableDefinition,
} from 'stripe-experiment-sync/openapi'

/**
 * Common Stripe object types that are typically synced.
 * These are the primary resource types that users care about.
 */
const COMMON_STRIPE_OBJECTS = [
  'customer',
  'product',
  'price',
  'subscription',
  'invoice',
  'charge',
  'payment_intent',
  'payment_method',
  'balance_transaction',
  'payout',
  'refund',
  'coupon',
  'discount',
  'tax_rate',
  'plan',
]

/**
 * GET /api/schema
 *
 * Fetches the Stripe OpenAPI specification and returns TableDefinition
 * objects for common Stripe resource types.
 *
 * Query params:
 *   - version: API version (currently only "current" is supported)
 *   - objects: Comma-separated list of object names to include (optional)
 */
export async function GET(request: NextRequest) {
  try {
    // Version param reserved for future use when we support historical versions
    request.nextUrl.searchParams.get('version')
    const objectsParam = request.nextUrl.searchParams.get('objects')

    // Determine which objects to fetch
    const objectNames = objectsParam
      ? objectsParam.split(',').map((s) => s.trim())
      : COMMON_STRIPE_OBJECTS

    // Fetch the OpenAPI spec (cached for 24 hours)
    const specPath = await fetchOpenAPISpec(undefined, { force: false })

    // Create parser and type mapper
    const parser = createOpenAPIParser()
    await parser.loadSpec(specPath)

    const typeMapper = createTypeMapper()

    // Convert each object to a TableDefinition
    const tables: TableDefinition[] = []
    const errors: string[] = []

    for (const objectName of objectNames) {
      try {
        const schema = parser.getObjectSchema(objectName)
        if (schema) {
          const table = typeMapper.mapObjectSchema(schema)
          tables.push(table)
        } else {
          errors.push(`Object '${objectName}' not found in spec`)
        }
      } catch (err) {
        errors.push(
          `Error processing '${objectName}': ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    return NextResponse.json({
      version: parser.getApiVersion(),
      tables,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
