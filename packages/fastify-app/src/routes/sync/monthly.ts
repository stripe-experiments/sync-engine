import { FastifyInstance } from 'fastify'
import { verifyApiKey } from '../../utils/verifyApiKey'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/monthly', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { object } = (request.body as { object?: string }) ?? {}
      const tables = (object && object !== 'all' ? [object] : undefined) as Parameters<
        typeof fastify.stripeSync.fullSync
      >[0]

      const result = await fastify.stripeSync.fullSync(tables)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
