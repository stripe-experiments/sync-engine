import { FastifyInstance } from 'fastify'
import { verifyApiKey } from '../utils/verifyApiKey'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { object } = (request.body as { object?: string }) ?? {}
      const tables = object && object !== 'all' ? ([object] as const) : undefined
      const result = await fastify.stripeSync.fullSync(tables as any)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })

  fastify.post<{
    Params: {
      stripeId: string
    }
  }>('/sync/single/:stripeId', {
    preHandler: [verifyApiKey],
    schema: {
      params: {
        type: 'object',
        properties: {
          stripeId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { stripeId } = request.params

      const result = await fastify.stripeSync.syncSingleEntity(stripeId)

      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        data: result,
      })
    },
  })
}
