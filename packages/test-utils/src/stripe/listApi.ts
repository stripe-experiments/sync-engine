import type { EndpointDefinition } from '../openapi/endpoints.js'

const DEFAULT_API_KEY = 'sk_test_fake'

export type StripeListPage = {
  data: Record<string, unknown>[]
  has_more: boolean
  next_page_url: string | null
  raw: Record<string, unknown>
}

export async function assertStripeMockAvailable(
  stripeMockUrl: string,
  fetchImpl: typeof globalThis.fetch
): Promise<void> {
  const url = new URL('/v1/customers', stripeMockUrl)
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
  })
  if (!res.ok) {
    throw new Error(`stripe-mock healthcheck failed (${res.status} ${res.statusText}) at ${url.toString()}`)
  }
}

export async function fetchStripeListPage(
  stripeMockUrl: string,
  endpoint: EndpointDefinition,
  query: URLSearchParams,
  fetchImpl: typeof globalThis.fetch
): Promise<StripeListPage> {
  const url = new URL(endpoint.apiPath, stripeMockUrl)
  if (query.size > 0) {
    url.search = query.toString()
  }

  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `stripe-mock request failed for ${endpoint.apiPath} (${res.status} ${res.statusText}): ${body.slice(0, 500)}`
    )
  }

  const raw = (await res.json()) as unknown
  return validateAndNormalizeListResponse(raw, endpoint)
}

export function validateAndNormalizeListResponse(
  payload: unknown,
  endpoint: EndpointDefinition
): StripeListPage {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Expected JSON object list response for ${endpoint.apiPath}`)
  }
  const raw = payload as Record<string, unknown>
  const data = raw.data
  if (!Array.isArray(data)) {
    throw new Error(`Expected "data" array in list response for ${endpoint.apiPath}`)
  }

  if (endpoint.isV2) {
    if (!Object.prototype.hasOwnProperty.call(raw, 'next_page_url')) {
      throw new Error(`Expected "next_page_url" in v2 list response for ${endpoint.apiPath}`)
    }
    const nextPage = raw.next_page_url
    if (nextPage !== null && typeof nextPage !== 'string') {
      throw new Error(`Expected "next_page_url" to be string|null for ${endpoint.apiPath}`)
    }
    return {
      data: data.filter(isRecord),
      has_more: Boolean(nextPage),
      next_page_url: nextPage ?? null,
      raw,
    }
  }

  if (typeof raw.has_more !== 'boolean') {
    throw new Error(`Expected "has_more" boolean in v1 list response for ${endpoint.apiPath}`)
  }

  return {
    data: data.filter(isRecord),
    has_more: raw.has_more,
    next_page_url: null,
    raw,
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input)
}
