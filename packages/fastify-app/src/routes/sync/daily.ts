import { FastifyInstance } from 'fastify'
import { verifyApiKey } from '../../utils/verifyApiKey'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/daily', {
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
}
