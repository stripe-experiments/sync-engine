export const DEFAULT_BASE = 'https://api.stripe.com'

export async function stripeGet<T>(apiKey: string, path: string, baseUrl?: string): Promise<T> {
  const base = baseUrl ?? DEFAULT_BASE
  const url = path.startsWith('http') ? path : `${base}${path}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Stripe API ${res.status}: ${body}`)
  }
  return (await res.json()) as T
}

export async function stripePost<T = unknown>(
  apiKey: string,
  path: string,
  params?: Record<string, string>,
  baseUrl?: string
): Promise<T> {
  const base = baseUrl ?? DEFAULT_BASE
  const body = params ? new URLSearchParams(params).toString() : undefined
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe API ${res.status}: ${text}`)
  }
  return (await res.json()) as T
}

export async function stripeDelete<T = unknown>(
  apiKey: string,
  path: string,
  baseUrl?: string
): Promise<T> {
  const base = baseUrl ?? DEFAULT_BASE
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe API ${res.status}: ${text}`)
  }
  return (await res.json()) as T
}
