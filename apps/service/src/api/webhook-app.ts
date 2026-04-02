import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'

export interface WebhookAppOptions {
  /** Called for each incoming webhook event. Fire-and-forget. */
  push_event: (pipelineId: string, event: unknown) => void
}

/**
 * Standalone webhook ingress app — POST /webhooks/{pipeline_id}.
 *
 * Used by `sync-service webhook` for production deployments where
 * webhook ingress runs on its own port/host.
 */
export function createWebhookApp({ push_event }: WebhookAppOptions) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })
  app.get('/health', (c) => c.text('ok'))

  app.openapi(
    createRoute({
      operationId: 'pushWebhook',
      method: 'post',
      path: '/webhooks/{pipeline_id}',
      tags: ['Webhooks'],
      summary: 'Ingest a Stripe webhook event',
      description:
        "Receives a raw Stripe webhook event, verifies its signature using the pipeline's webhook secret, and enqueues it for processing by the active pipeline.",
      request: {
        params: z.object({
          pipeline_id: z.string().openapi({
            param: { name: 'pipeline_id', in: 'path' },
            example: 'pipe_abc123',
          }),
        }),
      },
      responses: {
        200: {
          content: { 'text/plain': { schema: z.literal('ok') } },
          description: 'Event accepted',
        },
      },
    }),
    async (c) => {
      const { pipeline_id } = c.req.valid('param')
      const body = await c.req.text()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      push_event(pipeline_id, { body, headers })
      return c.text('ok', 200)
    }
  )

  app.get('/openapi.json', (c) =>
    c.json(
      app.getOpenAPIDocument({
        openapi: '3.0.0',
        info: {
          title: 'Stripe Sync Webhook Server',
          version: '1.0.0',
          description: 'Standalone webhook ingress — receives Stripe webhook events.',
        },
      })
    )
  )

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
