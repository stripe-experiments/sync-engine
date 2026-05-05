import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startWebhookServer, verifyWebhookSignature, type WebhookInput } from './webhook.js'

const SECRET = 'test-metronome-webhook-secret'

let server: ReturnType<typeof startWebhookServer> | undefined

function sign(body: string, date: string, secret = SECRET) {
  return createHmac('sha256', secret).update(`${date}\n${body}`).digest('hex')
}

async function startTestServer(
  push: (input: WebhookInput) => void | Promise<void>,
  secret = SECRET
) {
  server = startWebhookServer(0, secret, push)
  await new Promise<void>((resolve) => server!.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) =>
    server!.close((err) => (err ? reject(err) : resolve()))
  )
  server = undefined
})

describe('Metronome webhook handling', () => {
  it('verifies the documented HMAC over date newline body', () => {
    const body = JSON.stringify({
      id: 'evt_credit_create',
      type: 'credit.create',
      customer_id: 'cus_test_webhook',
    })
    const date = new Date().toUTCString()

    expect(() => verifyWebhookSignature(body, sign(body, date), date, SECRET)).not.toThrow()
    expect(() =>
      verifyWebhookSignature(body, sign(body, date, 'wrong-secret'), date, SECRET)
    ).toThrow(/signature verification failed/)
  })

  it('parses signed Metronome notification payloads and waits for async processing', async () => {
    const body = JSON.stringify({
      id: 'evt_credit_edit',
      type: 'credit.edit',
      customer_id: 'cus_test_webhook',
      properties: {
        customer_id: 'cus_test_webhook',
      },
    })
    const date = new Date().toUTCString()
    let pushed: WebhookInput | undefined
    const url = await startTestServer(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      pushed = input
    })

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        date,
        'metronome-webhook-signature': sign(body, date),
        'content-type': 'application/json',
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(pushed).toMatchObject({
      verified: true,
      raw_body: body,
      event: {
        id: 'evt_credit_edit',
        type: 'credit.edit',
        customer_id: 'cus_test_webhook',
      },
    })
  })

  it('rejects signed webhooks without Metronome signature headers', async () => {
    const url = await startTestServer(() => undefined)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'credit.create' }),
    })

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Missing Metronome-Webhook-Signature or Date header')
  })
})
