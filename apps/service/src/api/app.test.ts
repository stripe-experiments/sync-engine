import { describe, expect, it } from 'vitest'
import type { WorkflowClient } from '@temporalio/client'
import { createConnectorResolver, sourceTest, destinationTest } from '@stripe/sync-engine'
import { createApp } from './app.js'

// These tests cover routes that don't touch Temporal (OpenAPI spec, docs, health).
// Pipeline CRUD tests live in app.integration.test.ts with a real Temporal server.

const resolver = createConnectorResolver({
  sources: { test: sourceTest },
  destinations: { test: destinationTest },
})

function app() {
  return createApp({
    temporal: { client: {} as WorkflowClient, taskQueue: 'unused' },
    resolver,
  })
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const res = await app().request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes pipeline and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
    expect(paths).toContain('/webhooks/{pipeline_id}')
  })

  it('does not include removed pipeline operation paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).not.toContain('/pipelines/{id}/sync')
    expect(paths).not.toContain('/pipelines/{id}/setup')
    expect(paths).not.toContain('/pipelines/{id}/teardown')
    expect(paths).not.toContain('/pipelines/{id}/check')
    expect(paths).not.toContain('/pipelines/{id}/read')
    expect(paths).not.toContain('/pipelines/{id}/write')
    expect(paths).not.toContain('/pipelines/{id}/pause')
    expect(paths).not.toContain('/pipelines/{id}/resume')
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const res = await app().request('/docs')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
