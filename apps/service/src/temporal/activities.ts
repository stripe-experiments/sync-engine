import { heartbeat } from '@temporalio/activity'
import { parseNdjsonStream } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'
import type { RunResult } from './types.js'

/**
 * Resolve a sync's config with credentials inlined from the service,
 * then build the X-Pipeline header value for the engine API.
 */
async function resolveParams(serviceUrl: string, pipelineId: string): Promise<string> {
  const resp = await fetch(`${serviceUrl}/pipelines/${pipelineId}`)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to resolve pipeline ${pipelineId} (${resp.status}): ${text}`)
  }
  const config = (await resp.json()) as {
    source: { name: string; [k: string]: unknown }
    destination: { name: string; [k: string]: unknown }
    streams?: Array<{ name: string; sync_mode?: string }>
  }
  return JSON.stringify({
    source: config.source,
    destination: config.destination,
    streams: config.streams,
  })
}

export function createActivities(opts: {
  serviceUrl: string
  engineUrl: string
  kafkaBroker?: string
}) {
  const { serviceUrl, engineUrl, kafkaBroker } = opts

  // Shared Kafka client + producer (created lazily, reused across activity calls)
  let kafka: Kafka | undefined
  let producerConnected: Promise<import('kafkajs').Producer> | undefined

  function getKafka(): Kafka {
    if (!kafka) {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')
      kafka = new Kafka({ brokers: [kafkaBroker] })
    }
    return kafka
  }

  function getProducer(): Promise<import('kafkajs').Producer> {
    if (!producerConnected) {
      const producer = getKafka().producer()
      producerConnected = producer.connect().then(() => producer)
    }
    return producerConnected
  }

  function topicName(pipelineId: string): string {
    return `pipeline.${pipelineId}`
  }

  return {
    async setup(pipelineId: string): Promise<void> {
      const params = await resolveParams(serviceUrl, pipelineId)
      const resp = await fetch(`${engineUrl}/setup`, {
        method: 'POST',
        headers: { 'X-Pipeline': params },
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Setup failed (${resp.status}): ${text}`)
      }
    },

    async sync(
      pipelineId: string,
      opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
    ): Promise<RunResult> {
      const params = await resolveParams(serviceUrl, pipelineId)
      const headers: Record<string, string> = { 'X-Pipeline': params }
      let body: string | undefined

      if (opts?.state && Object.keys(opts.state).length > 0) {
        headers['X-State'] = JSON.stringify(opts.state)
      }
      if (opts?.stateLimit != null) {
        headers['X-State-Checkpoint-Limit'] = String(opts.stateLimit)
      }
      if (opts?.input && opts.input.length > 0) {
        headers['Content-Type'] = 'application/x-ndjson'
        body = opts.input.map((item) => JSON.stringify(item)).join('\n') + '\n'
      }

      const resp = await fetch(`${engineUrl}/sync`, {
        method: 'POST',
        headers,
        body,
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Sync failed (${resp.status}): ${text}`)
      }

      const errors: RunResult['errors'] = []
      const state: Record<string, unknown> = {}
      let messageCount = 0

      for await (const msg of parseNdjsonStream(resp.body!)) {
        const m = msg as Record<string, unknown>
        messageCount++

        if (m.type === 'error') {
          errors.push({
            message:
              (m.message as string) ||
              ((m.data as Record<string, unknown>)?.message as string) ||
              'Unknown error',
            failure_type: m.failure_type as string | undefined,
            stream: m.stream as string | undefined,
          })
        } else if (m.type === 'state' && typeof m.stream === 'string') {
          state[m.stream] = m.data
        }

        if (messageCount % 50 === 0) {
          heartbeat({ messages: messageCount })
        }
      }
      if (messageCount % 50 !== 0) {
        heartbeat({ messages: messageCount })
      }

      return { errors, state }
    },

    async read(
      pipelineId: string,
      opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
    ): Promise<{ count: number; records: unknown[]; state: Record<string, unknown> }> {
      const params = await resolveParams(serviceUrl, pipelineId)
      const headers: Record<string, string> = { 'X-Pipeline': params }
      let body: string | undefined

      if (opts?.state && Object.keys(opts.state).length > 0) {
        headers['X-State'] = JSON.stringify(opts.state)
      }
      if (opts?.stateLimit != null) {
        headers['X-State-Checkpoint-Limit'] = String(opts.stateLimit)
      }
      if (opts?.input && opts.input.length > 0) {
        headers['Content-Type'] = 'application/x-ndjson'
        body = opts.input.map((item) => JSON.stringify(item)).join('\n') + '\n'
      }

      const resp = await fetch(`${engineUrl}/read`, { method: 'POST', headers, body })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Read failed (${resp.status}): ${text}`)
      }

      const records: unknown[] = []
      const state: Record<string, unknown> = {}
      let messageCount = 0

      for await (const msg of parseNdjsonStream(resp.body!)) {
        const m = msg as Record<string, unknown>
        messageCount++
        if (m.type === 'record') {
          records.push(m)
        } else if (m.type === 'state' && typeof m.stream === 'string') {
          state[m.stream] = m.data
        }
        if (messageCount % 50 === 0) heartbeat({ messages: messageCount })
      }
      if (messageCount % 50 !== 0) heartbeat({ messages: messageCount })

      // If Kafka is configured, produce records to the pipeline topic
      if (kafkaBroker && records.length > 0) {
        const producer = await getProducer()
        await producer.send({
          topic: topicName(pipelineId),
          messages: records.map((r) => ({ value: JSON.stringify(r) })),
        })
      }

      return { count: records.length, records, state }
    },

    async write(
      pipelineId: string,
      opts?: { records?: unknown[]; maxBatch?: number }
    ): Promise<RunResult & { written: number }> {
      const params = await resolveParams(serviceUrl, pipelineId)
      let records: unknown[]

      if (kafkaBroker) {
        // Consume a batch from Kafka
        const maxBatch = opts?.maxBatch ?? 50
        records = []
        const consumer = getKafka().consumer({ groupId: `pipeline.${pipelineId}` })
        await consumer.connect()
        await consumer.subscribe({ topic: topicName(pipelineId), fromBeginning: false })

        await new Promise<void>((resolve) => {
          consumer.run({
            eachMessage: async ({ message }) => {
              if (message.value) {
                records.push(JSON.parse(message.value.toString()))
              }
              if (records.length >= maxBatch) {
                resolve()
              }
            },
          })
          // If fewer than maxBatch messages are available, resolve after a short wait
          setTimeout(resolve, 2000)
        })

        await consumer.disconnect()
      } else {
        // In-memory mode: records passed directly
        records = opts?.records ?? []
      }

      if (records.length === 0) {
        return { errors: [], state: {}, written: 0 }
      }

      const headers: Record<string, string> = {
        'X-Pipeline': params,
        'Content-Type': 'application/x-ndjson',
      }
      const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n'

      const resp = await fetch(`${engineUrl}/write`, { method: 'POST', headers, body })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Write failed (${resp.status}): ${text}`)
      }

      const errors: RunResult['errors'] = []
      const state: Record<string, unknown> = {}
      let messageCount = 0

      for await (const msg of parseNdjsonStream(resp.body!)) {
        const m = msg as Record<string, unknown>
        messageCount++
        if (m.type === 'error') {
          errors.push({
            message:
              (m.message as string) ||
              ((m.data as Record<string, unknown>)?.message as string) ||
              'Unknown error',
            failure_type: m.failure_type as string | undefined,
            stream: m.stream as string | undefined,
          })
        } else if (m.type === 'state' && typeof m.stream === 'string') {
          state[m.stream] = m.data
        }
        if (messageCount % 50 === 0) heartbeat({ messages: messageCount })
      }
      if (messageCount % 50 !== 0) heartbeat({ messages: messageCount })

      return { errors, state, written: records.length }
    },

    async teardown(pipelineId: string): Promise<void> {
      const params = await resolveParams(serviceUrl, pipelineId)
      const resp = await fetch(`${engineUrl}/teardown`, {
        method: 'POST',
        headers: { 'X-Pipeline': params },
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Teardown failed (${resp.status}): ${text}`)
      }
    },
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
