export interface ResourceDefinition {
  /** Stream/table name */
  name: string
  /** API endpoint path */
  endpoint: string
  /** HTTP method */
  method: 'GET' | 'POST'
  /** JSON Schema for the record shape */
  jsonSchema: Record<string, unknown>
  /** Primary key field paths */
  primaryKey: string[][]
  /** If true, requires iterating parent customers first */
  perCustomer?: boolean
  /** If true, requires iterating parent customers AND their contracts */
  perContract?: boolean
  /** Merged into POST body when fanning out per customer or per contract */
  postBodyMerge?: Record<string, unknown>
  /** POST list: `limit` field per request (defaults to client global page size). */
  pageLimit?: number
  /**
   * `list` — normal `{ data[], next_page }` pagination (default).
   * `single_object` — one JSON object per POST (no `data` pagination), used for getNetBalance.
   */
  responseKind?: 'list' | 'single_object'
  /** If true for `single_object`, emit the response's `data` object instead of the wrapper. */
  unwrapData?: boolean
  /**
   * When set with `perCustomer` list APIs: one output record per HTTP page with `items` = `data` rows
   * (customerBalances/list).
   */
  emitPageSnapshots?: boolean
  /** Human-readable MVP catalog notes (discover / operators; not sent to API). */
  catalogNotes?: string
}

export const resources: ResourceDefinition[] = [
  {
    name: 'customers',
    endpoint: '/v1/customers',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        external_id: { type: 'string' },
        ingest_aliases: { type: 'array', items: { type: 'string' } },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
        archived_at: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'billable_metrics',
    endpoint: '/v1/billable-metrics',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        group_keys: { type: 'array' },
        aggregation_type: { type: 'string' },
        aggregation_key: { type: ['string', 'null'] },
        event_type_filter: { type: 'object' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'plans',
    endpoint: '/v1/plans',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'contracts',
    endpoint: '/v2/contracts/list',
    method: 'POST',
    primaryKey: [['id']],
    perCustomer: true,
    catalogNotes:
      'Parent fanout: customers. Cursor in POST body. Redis: metronome:contract:{id} or per-customer aggregates.',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customer_id: { type: 'string' },
        rate_card_id: { type: ['string', 'null'] },
        starting_at: { type: 'string' },
        ending_before: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'balances',
    endpoint: '/v1/contracts/customerBalances/list',
    method: 'POST',
    primaryKey: [['customer_id'], ['_page_slot']],
    perCustomer: true,
    emitPageSnapshots: true,
    pageLimit: 25,
    postBodyMerge: {
      include_balance: true,
      include_contract_balances: true,
      include_ledgers: false,
    },
    catalogNotes:
      'One record per paginated page; primary key is customer + page index. Redis intent: metronome:customer:{customer_id}:balances:{page_tag}.',
    jsonSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        _page_slot: { type: 'integer' },
        items: { type: 'array' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'net_balance',
    endpoint: '/v1/contracts/customerBalances/getNetBalance',
    method: 'POST',
    primaryKey: [['customer_id']],
    perCustomer: true,
    responseKind: 'single_object',
    unwrapData: true,
    catalogNotes:
      'Single object per customer. Redis intent: metronome:customer:{customer_id}:net_balance.',
    jsonSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        balance: { type: 'number' },
        credit_type_id: { type: 'string' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'credits',
    endpoint: '/v1/contracts/customerCredits/list',
    method: 'POST',
    primaryKey: [['id']],
    perCustomer: true,
    pageLimit: 25,
    postBodyMerge: {
      include_balance: true,
      include_contract_credits: true,
      include_ledgers: false,
    },
    catalogNotes:
      'Customer-scoped credit rows (distinct from credit_grants). Redis intent: metronome:credit:{id}.',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customer_id: { type: 'string' },
        balance: { type: 'object' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'commits',
    endpoint: '/v1/contracts/customerCommits/list',
    method: 'POST',
    primaryKey: [['id']],
    perCustomer: true,
    pageLimit: 25,
    postBodyMerge: {
      include_balance: true,
      include_contract_commits: true,
      include_ledgers: false,
    },
    catalogNotes:
      'Customer-scoped commit rows. Redis intent: metronome:commit:{id}.',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customer_id: { type: 'string' },
        balance: { type: 'object' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'products',
    endpoint: '/v1/contract-pricing/products/list',
    method: 'POST',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'rate_cards',
    endpoint: '/v1/contract-pricing/rate-cards/list',
    method: 'POST',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'invoices',
    endpoint: '/v1/invoices',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customer_id: { type: 'string' },
        status: { type: 'string' },
        total: { type: 'number' },
        credit_type: { type: 'object' },
        start_timestamp: { type: 'string' },
        end_timestamp: { type: 'string' },
        line_items: { type: 'array' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'entitlements',
    endpoint: '/v1/contracts/getContractRateSchedule',
    method: 'POST',
    primaryKey: [['customer_id'], ['contract_id'], ['product_id']],
    perContract: true,
    jsonSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        contract_id: { type: 'string' },
        product_id: { type: 'string' },
        product_name: { type: 'string' },
        product_tags: { type: 'array', items: { type: 'string' } },
        product_custom_fields: { type: 'object' },
        rate_card_id: { type: 'string' },
        entitled: { type: 'boolean' },
        starting_at: { type: 'string' },
        ending_before: { type: ['string', 'null'] },
        list_rate: { type: 'object' },
        override_rate: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
]
