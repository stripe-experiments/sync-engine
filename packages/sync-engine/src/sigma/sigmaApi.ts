import Papa from 'papaparse'
import Stripe from 'stripe'
import pkg from '../../package.json' with { type: 'json' }
import type { Logger } from '../types'

export type SigmaQueryRunStatus = 'running' | 'succeeded' | 'failed'

type SigmaQueryRun = {
  id: string
  status: SigmaQueryRunStatus
  error: unknown | null
  result?: {
    file?: string | null
  }
}

const STRIPE_FILES_BASE = 'https://files.stripe.com/v1'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseCsvObjects(csv: string): Array<Record<string, string | null>> {
  const input = csv.replace(/^\uFEFF/, '')

  const parsed = Papa.parse<Record<string, string>>(input, {
    header: true,
    skipEmptyLines: 'greedy',
  })

  if (parsed.errors.length > 0) {
    throw new Error(`Failed to parse Sigma CSV: ${parsed.errors[0]?.message ?? 'unknown error'}`)
  }

  return parsed.data
    .filter((row) => row && Object.keys(row).length > 0)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v == null || v === '' ? null : String(v)])
      )
    )
}

export function normalizeSigmaTimestampToIso(value: string): string | null {
  const v = value.trim()
  if (!v) return null

  const hasExplicitTz = /z$|[+-]\d{2}:?\d{2}$/i.test(v)
  const isoish = v.includes('T') ? v : v.replace(' ', 'T')
  const candidate = hasExplicitTz ? isoish : `${isoish}Z`

  const d = new Date(candidate)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, {
    appInfo: {
      name: 'Stripe Sync Engine',
      version: pkg.version,
      url: pkg.homepage,
    },
  })
}

async function fetchStripeText(url: string, apiKey: string, options: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Sigma file download error (${res.status}) for ${url}: ${text}`)
  }
  return text
}

export async function createSigmaQueryRun(params: {
  apiKey: string
  sql: string
}): Promise<{ queryRunId: string }> {
  const stripe = createStripeClient(params.apiKey)
  const created = (await stripe.rawRequest('POST', '/v1/sigma/query_runs', {
    sql: params.sql,
  })) as unknown as SigmaQueryRun

  return { queryRunId: created.id }
}

export async function getSigmaQueryRun(params: {
  apiKey: string
  queryRunId: string
}): Promise<{ status: SigmaQueryRunStatus; fileId?: string; error?: unknown }> {
  const stripe = createStripeClient(params.apiKey)
  const current = (await stripe.rawRequest(
    'GET',
    `/v1/sigma/query_runs/${params.queryRunId}`,
    {}
  )) as unknown as SigmaQueryRun

  return {
    status: current.status,
    fileId: current.result?.file ?? undefined,
    error: current.error ?? undefined,
  }
}

export async function downloadSigmaFile(params: {
  apiKey: string
  fileId: string
}): Promise<string> {
  return await fetchStripeText(
    `${STRIPE_FILES_BASE}/files/${params.fileId}/contents`,
    params.apiKey,
    { method: 'GET' }
  )
}

export async function runSigmaQueryAndDownloadCsv(params: {
  apiKey: string
  sql: string
  logger?: Logger
  pollTimeoutMs?: number
  pollIntervalMs?: number
}): Promise<{ queryRunId: string; fileId: string; csv: string }> {
  const pollTimeoutMs = params.pollTimeoutMs ?? 5 * 60 * 1000
  const pollIntervalMs = params.pollIntervalMs ?? 2000

  // 1) Create query run
  const { queryRunId } = await createSigmaQueryRun({ apiKey: params.apiKey, sql: params.sql })

  // 2) Poll until succeeded
  const start = Date.now()
  let current: SigmaQueryRun = {
    id: queryRunId,
    status: 'running',
    error: null,
    result: {},
  }

  while (current.status === 'running') {
    if (Date.now() - start > pollTimeoutMs) {
      throw new Error(`Sigma query run timed out after ${pollTimeoutMs}ms: ${queryRunId}`)
    }
    await sleep(pollIntervalMs)

    const next = await getSigmaQueryRun({ apiKey: params.apiKey, queryRunId })
    current = {
      id: queryRunId,
      status: next.status,
      error: next.error ?? null,
      result: { file: next.fileId ?? null },
    }
  }

  if (current.status !== 'succeeded') {
    throw new Error(
      `Sigma query run did not succeed (status=${current.status}) id=${queryRunId} error=${JSON.stringify(
        current.error
      )}`
    )
  }

  const fileId = current.result?.file
  if (!fileId) {
    throw new Error(`Sigma query run succeeded but result.file is missing (id=${queryRunId})`)
  }

  // 3) Download file contents (CSV)
  const csv = await downloadSigmaFile({ apiKey: params.apiKey, fileId })

  return { queryRunId, fileId, csv }
}
