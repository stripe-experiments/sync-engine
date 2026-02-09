import { NextResponse } from 'next/server'

/**
 * GET /api/versions
 *
 * Returns available Stripe API versions for schema visualization.
 * Currently returns the "current" version which fetches the latest
 * OpenAPI spec from GitHub.
 */
export async function GET() {
  try {
    // For now, we only support the "current" version which fetches
    // the latest OpenAPI spec from Stripe's GitHub repository.
    // In the future, this could be extended to support historical versions.
    const versions = ['current']

    return NextResponse.json({ versions })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
