import type { Message } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'
import type { Producer } from 'kafkajs'

export interface ActivitiesContext {
  engineUrl: string
  kafkaBroker?: string
  getProducer(): Promise<Producer>
  consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]>
}

export function createActivitiesContext(opts: {
  engineUrl: string
  kafkaBroker?: string
}): ActivitiesContext {
  const { engineUrl, kafkaBroker } = opts

  let kafka: Kafka | undefined
  let producerConnected: Promise<Producer> | undefined

  function getKafka(): Kafka {
    if (!kafka) {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')
      kafka = new Kafka({ brokers: [kafkaBroker] })
    }
    return kafka
  }

  function topicName(pipelineId: string): string {
    return `pipeline.${pipelineId}`
  }

  async function getProducer(): Promise<Producer> {
    if (!producerConnected) {
      const producer = getKafka().producer()
      producerConnected = producer.connect().then(() => producer)
    }
    return producerConnected
  }

  async function consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]> {
    if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')

    const topic = topicName(pipelineId)
    const messages: Message[] = []
    const offsets = new Map<number, string>()
    const consumer = getKafka().consumer({ groupId: `pipeline.${pipelineId}` })
    await consumer.connect()
    await consumer.subscribe({ topic, fromBeginning: true })

    try {
      await new Promise<void>((resolve) => {
        let resolved = false
        const finish = () => {
          if (resolved) return
          resolved = true
          resolve()
        }

        consumer.run({
          eachMessage: async ({ partition, message }) => {
            if (message.value) {
              messages.push(JSON.parse(message.value.toString()) as Message)
              offsets.set(partition, (BigInt(message.offset) + 1n).toString())
            }
            if (messages.length >= maxBatch) finish()
          },
        })

        setTimeout(finish, 2000)
      })

      await consumer.stop()

      if (offsets.size > 0) {
        await consumer.commitOffsets(
          [...offsets.entries()].map(([partition, offset]) => ({
            topic,
            partition,
            offset,
          }))
        )
      }
    } finally {
      await consumer.disconnect()
    }

    return messages
  }

  return {
    engineUrl,
    kafkaBroker,
    getProducer,
    consumeQueueBatch,
  }
}
