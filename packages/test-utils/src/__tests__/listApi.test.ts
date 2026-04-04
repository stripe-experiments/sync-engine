import { describe, expect, it } from 'vitest'
import { validateAndNormalizeListResponse } from '../stripe/listApi.js'
import type { EndpointDefinition } from '../openapi/endpoints.js'

const baseEndpoint: Omit<EndpointDefinition, 'isV2'> = {
  tableName: 'customers',
  resourceId: 'customer',
  apiPath: '/v1/customers',
  supportsCreatedFilter: true,
  supportsLimit: true,
  queryParams: [],
}

describe('validateAndNormalizeListResponse', () => {
  it('supports v1 list shape with has_more', () => {
    const endpoint: EndpointDefinition = { ...baseEndpoint, isV2: false }
    const normalized = validateAndNormalizeListResponse(
      {
        object: 'list',
        has_more: false,
        data: [{ id: 'cus_123', object: 'customer' }],
      },
      endpoint
    )
    expect(normalized.data).toHaveLength(1)
    expect(normalized.has_more).toBe(false)
    expect(normalized.next_page_url).toBeNull()
  })

  it('supports v2 list shape with next_page_url', () => {
    const endpoint: EndpointDefinition = { ...baseEndpoint, isV2: true, apiPath: '/v2/core/events' }
    const normalized = validateAndNormalizeListResponse(
      {
        data: [{ id: 'evt_123', object: 'event' }],
        next_page_url: '/v2/core/events?page=foo',
      },
      endpoint
    )
    expect(normalized.data).toHaveLength(1)
    expect(normalized.has_more).toBe(true)
    expect(normalized.next_page_url).toBe('/v2/core/events?page=foo')
  })
})
