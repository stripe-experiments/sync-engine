import { describe, expect, it } from 'vitest'
import createClient from 'openapi-fetch'
import type { WorkflowClient } from '@temporalio/client'
import { createApp } from './app.js'
import type { paths } from '../__generated__/openapi.js'
import type { Pipeline } from '../lib/schemas.js'

// ---------------------------------------------------------------------------
// In-memory Temporal client (backs the app without a real Temporal server)
// ---------------------------------------------------------------------------

function inMemoryWorkflowClient(): WorkflowClient {
  const store = new Map<string, { pipeline: Pipeline; paused: boolean }>()

  return {
    start(_workflow: string, options: any) {
      const [pipeline] = options.args as [Pipeline]
      store.set(options.workflowId, { pipeline, paused: false })
      return Promise.resolve({ workflowId: options.workflowId })
    },
    getHandle(workflowId: string) {
      return {
        signal(signalName: string, ...args: unknown[]) {
          const entry = store.get(workflowId)
          if (!entry) return Promise.reject(new Error(`Workflow not found: ${workflowId}`))
          if (signalName === 'delete') {
            store.delete(workflowId)
          } else if (signalName === 'update') {
            const patch = args[0] as Record<string, unknown>
            if (patch.source) entry.pipeline.source = patch.source as any
            if (patch.destination) entry.pipeline.destination = patch.destination as any
            if (patch.streams !== undefined) entry.pipeline.streams = patch.streams as any
            if ('paused' in patch) entry.paused = !!patch.paused
          }
          return Promise.resolve()
        },
        query(queryName: string) {
          const entry = store.get(workflowId)
          if (!entry) return Promise.reject(new Error(`Workflow not found: ${workflowId}`))
          if (queryName === 'config') return Promise.resolve(entry.pipeline)
          if (queryName === 'status')
            return Promise.resolve({ phase: 'running', paused: entry.paused, iteration: 1 })
          if (queryName === 'state') return Promise.resolve({})
          return Promise.reject(new Error(`Unknown query: ${queryName}`))
        },
        terminate() {
          store.delete(workflowId)
          return Promise.resolve()
        },
      }
    },
    list() {
      const entries = [...store.values()]
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of entries) {
            yield { memo: { pipeline: entry.pipeline } }
          }
        },
      }
    },
  } as unknown as WorkflowClient
}

/** Create a typed openapi-fetch client backed by the Hono app's fetch. */
function createTestClient() {
  const app = createApp({
    temporal: { client: inMemoryWorkflowClient(), taskQueue: 'test' },
  })
  const client = createClient<paths>({
    baseUrl: 'http://localhost',
    fetch: app.fetch as unknown as typeof globalThis.fetch,
  })
  return { app, client }
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const { app } = createTestClient()
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.0.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes pipeline and webhook paths', async () => {
    const { app } = createTestClient()
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
    expect(paths).toContain('/webhooks/{pipeline_id}')
  })

  it('does not include removed pipeline operation paths', async () => {
    const { app } = createTestClient()
    const res = await app.request('/openapi.json')
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
    const { app } = createTestClient()
    const res = await app.request('/docs')
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
    const { client } = createTestClient()
    const { data, error } = await client.GET('/health')
    expect(error).toBeUndefined()
    expect(data).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Pipelines CRUD
// ---------------------------------------------------------------------------

describe('pipelines', () => {
  it('create → get → list → update → delete', async () => {
    const { client } = createTestClient()

    // Create pipeline
    const { data: created, error: createErr } = await client.POST('/pipelines', {
      body: {
        source: { name: 'stripe', api_key: 'sk_test_123' },
        destination: { name: 'postgres', connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'customers' }],
      },
    })
    expect(createErr).toBeUndefined()
    expect(created!.id).toMatch(/^pipe_/)
    expect(created!.source.name).toBe('stripe')

    const pipelineId = created!.id

    // Get (includes status from query)
    const { data: got, error: getErr } = await client.GET('/pipelines/{id}', {
      params: { path: { id: pipelineId } },
    })
    expect(getErr).toBeUndefined()
    expect(got!.status?.phase).toBe('running')

    // List
    const { data: list, error: listErr } = await client.GET('/pipelines')
    expect(listErr).toBeUndefined()
    expect(list!.data).toHaveLength(1)
    expect(list!.has_more).toBe(false)

    // Update
    const { data: updated, error: updateErr } = await client.PATCH('/pipelines/{id}', {
      params: { path: { id: pipelineId } },
      body: { streams: [{ name: 'products' }] },
    })
    expect(updateErr).toBeUndefined()
    expect(updated).toEqual({ ok: true })

    // Delete
    const { data: deleted, error: deleteErr } = await client.DELETE('/pipelines/{id}', {
      params: { path: { id: pipelineId } },
    })
    expect(deleteErr).toBeUndefined()
    expect(deleted).toEqual({ id: pipelineId, deleted: true })

    // Get after delete → 404
    const { error: notFoundErr } = await client.GET('/pipelines/{id}', {
      params: { path: { id: pipelineId } },
    })
    expect(notFoundErr).toBeDefined()
  })

  it('returns 404 for non-existent pipeline', async () => {
    const { client } = createTestClient()
    const { error } = await client.GET('/pipelines/{id}', {
      params: { path: { id: 'pipe_nope' } },
    })
    expect(error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

describe('POST /webhooks/:pipeline_id', () => {
  it('accepts webhook events and returns ok', async () => {
    const { client } = createTestClient()
    const { data, response } = await client.POST('/webhooks/{pipeline_id}', {
      params: { path: { pipeline_id: 'pipe_abc123' } },
      body: { type: 'checkout.session.completed' } as any,
      parseAs: 'text',
    })
    expect(response.status).toBe(200)
    expect(data).toBe('ok')
  })
})
