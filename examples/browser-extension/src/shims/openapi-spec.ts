// Browser-friendly replacement for @stripe/sync-openapi's specFetchHelper.
// Imports the bundled OAS JSON via Vite's asset loader instead of fs.readFile.

import bundledSpec from '../../../../packages/openapi/oas/2026-03-25.dahlia.json'

export const BUNDLED_API_VERSION = '2026-03-25.dahlia' as const

export const SUPPORTED_API_VERSIONS = [BUNDLED_API_VERSION] as const

export interface ResolvedSpec {
  apiVersion: string
  spec: unknown
  source: 'bundled'
  cachePath: string
}

export async function resolveOpenApiSpec(
  config: { apiVersion?: string },
  _fetch: typeof globalThis.fetch
): Promise<ResolvedSpec> {
  const apiVersion = config.apiVersion ?? BUNDLED_API_VERSION
  if (apiVersion !== BUNDLED_API_VERSION) {
    throw new Error(
      `Browser bundle only includes API version ${BUNDLED_API_VERSION}; got "${apiVersion}"`
    )
  }
  return {
    apiVersion,
    spec: bundledSpec,
    source: 'bundled',
    cachePath: 'bundled',
  }
}
