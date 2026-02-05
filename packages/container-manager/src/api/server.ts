import Fastify from 'fastify'
import cors from '@fastify/cors'
import { DockerManager } from '../docker/manager.js'
import { getDbStats } from '../db/customerCount.js'
import type { ContainerConfig } from '../types.js'

// Initialize DockerManager
const dockerManager = new DockerManager()
let initialized = false

const ensureInitialized = async () => {
  if (!initialized) {
    await dockerManager.initialize()
    initialized = true
  }
}

export async function createServer() {
  const fastify = Fastify({ logger: true })

  await fastify.register(cors)

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', service: 'stripe-sync-container-manager' }
  })

  // List all containers
  fastify.get('/api/containers', async (request, reply) => {
    await ensureInitialized()

    try {
      const containers = await dockerManager.listContainers()
      const query = request.query as { stats?: string }
      const includeStats = query.stats === 'true'

      if (includeStats) {
        const containersWithStats = await Promise.all(
          containers.map(async (container) => {
            if (container.status === 'running') {
              const stats = await getDbStats(container.name)
              return { ...container, stats: stats || null }
            }
            return { ...container, stats: null }
          })
        )
        return { containers: containersWithStats }
      }

      return { containers }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to list containers' }
    }
  })

  // Get a specific container
  fastify.get('/api/containers/:id', async (request, reply) => {
    await ensureInitialized()

    const { id } = request.params as { id: string }

    try {
      const containers = await dockerManager.listContainers()
      const container = containers.find((c) => c.id === id || c.name === id)

      if (!container) {
        reply.code(404)
        return { error: 'Container not found' }
      }

      return { container }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to get container' }
    }
  })

  // Get container stats
  fastify.get('/api/containers/:id/stats', async (request, reply) => {
    await ensureInitialized()

    const { id } = request.params as { id: string }

    try {
      const containers = await dockerManager.listContainers()
      const container = containers.find((c) => c.id === id || c.name === id)

      if (!container) {
        reply.code(404)
        return { error: 'Container not found' }
      }

      if (container.status !== 'running') {
        reply.code(400)
        return { error: 'Container is not running' }
      }

      const stats = await getDbStats(container.name)

      if (!stats) {
        reply.code(503)
        return { error: 'Stats not available - database may not be ready' }
      }

      return { stats }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to get stats' }
    }
  })

  // Create a new container
  fastify.post('/api/containers', async (request, reply) => {
    await ensureInitialized()

    try {
      const body = request.body as ContainerConfig

      if (!body.stripeApiKey) {
        reply.code(400)
        return { error: 'stripeApiKey is required' }
      }

      if (!body.stripeApiKey.startsWith('sk_') && !body.stripeApiKey.startsWith('rk_')) {
        reply.code(400)
        return { error: 'Invalid Stripe API key. Must start with sk_ or rk_' }
      }

      if (dockerManager.hasContainerForStripeKey(body.stripeApiKey)) {
        reply.code(409)
        return { error: 'A container with this Stripe API key already exists' }
      }

      const container = await dockerManager.spawnContainer({
        stripeApiKey: body.stripeApiKey,
        name: body.name,
        port: body.port,
      })

      if (container.status === 'error') {
        reply.code(500)
        return { error: container.error || 'Failed to create container' }
      }

      reply.code(201)
      return { container }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to create container' }
    }
  })

  // Start a container
  fastify.post('/api/containers/:id/start', async (request, reply) => {
    await ensureInitialized()

    const { id } = request.params as { id: string }

    try {
      const containers = await dockerManager.listContainers()
      const container = containers.find((c) => c.id === id || c.name === id)

      if (!container) {
        reply.code(404)
        return { error: 'Container not found' }
      }

      if (container.status === 'running') {
        reply.code(400)
        return { error: 'Container is already running' }
      }

      await dockerManager.startContainer(container.id)

      return {
        message: `Container ${container.name} started`,
        container: { ...container, status: 'running' },
      }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to start container' }
    }
  })

  // Stop a container
  fastify.post('/api/containers/:id/stop', async (request, reply) => {
    await ensureInitialized()

    const { id } = request.params as { id: string }

    try {
      const containers = await dockerManager.listContainers()
      const container = containers.find((c) => c.id === id || c.name === id)

      if (!container) {
        reply.code(404)
        return { error: 'Container not found' }
      }

      if (container.status !== 'running') {
        reply.code(400)
        return { error: 'Container is not running' }
      }

      await dockerManager.stopContainer(container.id)

      return {
        message: `Container ${container.name} stopped`,
        container: { ...container, status: 'stopped' },
      }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to stop container' }
    }
  })

  // Delete a container
  fastify.delete('/api/containers/:id', async (request, reply) => {
    await ensureInitialized()

    const { id } = request.params as { id: string }

    try {
      const containers = await dockerManager.listContainers()
      const container = containers.find((c) => c.id === id || c.name === id)

      if (!container) {
        reply.code(404)
        return { error: 'Container not found' }
      }

      await dockerManager.deleteContainer(container.id)

      return { message: `Container ${container.name} deleted` }
    } catch (error) {
      reply.code(500)
      return { error: error instanceof Error ? error.message : 'Failed to delete container' }
    }
  })

  return fastify
}

// Start server function
export async function startServer(port: number = 3456): Promise<void> {
  const server = await createServer()

  try {
    await server.listen({ port, host: '0.0.0.0' })
    console.log(`\nAPI server running at http://localhost:${port}`)
    console.log('\nAvailable endpoints:')
    console.log('  GET    /health                     - Health check')
    console.log('  GET    /api/containers             - List all containers')
    console.log('  GET    /api/containers?stats=true  - List containers with stats')
    console.log('  POST   /api/containers             - Create a new container')
    console.log('  GET    /api/containers/:id         - Get a specific container')
    console.log('  GET    /api/containers/:id/stats   - Get container stats')
    console.log('  POST   /api/containers/:id/start   - Start a container')
    console.log('  POST   /api/containers/:id/stop    - Stop a container')
    console.log('  DELETE /api/containers/:id         - Delete a container')
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}
