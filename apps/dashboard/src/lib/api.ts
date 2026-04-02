import type { CatalogStream } from './stream-groups'

const ENGINE_BASE = '/api/engine'
const SERVICE_BASE = '/api/service'

// ── Engine API ────────────────────────────────────────────────

export interface ConnectorInfo {
  config_schema: Record<string, unknown>
}

export interface ConnectorsResponse {
  sources: Record<string, ConnectorInfo>
  destinations: Record<string, ConnectorInfo>
}

export async function getConnectors(): Promise<ConnectorsResponse> {
  const res = await fetch(`${ENGINE_BASE}/connectors`)
  if (!res.ok) throw new Error(`GET /connectors: ${res.status}`)
  return res.json()
}

export interface CatalogResponse {
  type: 'catalog'
  streams: CatalogStream[]
}

export async function discover(source: Record<string, unknown>): Promise<CatalogResponse> {
  const res = await fetch(`${ENGINE_BASE}/discover`, {
    method: 'POST',
    headers: {
      'x-pipeline': JSON.stringify({ source, destination: { type: '_' } }),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `Discover failed: ${res.status}`)
  }
  return res.json()
}

// ── Service API ───────────────────────────────────────────────

export interface CreatePipelineParams {
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams: Array<{ name: string }>
}

export interface Pipeline {
  id: string
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams?: Array<{ name: string }>
}

export async function createPipeline(params: CreatePipelineParams): Promise<Pipeline> {
  const res = await fetch(`${SERVICE_BASE}/pipelines`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `Create failed: ${res.status}`)
  }
  return res.json()
}
