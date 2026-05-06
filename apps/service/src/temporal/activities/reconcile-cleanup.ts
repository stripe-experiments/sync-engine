import { heartbeat } from '@temporalio/activity'
import { createStripeSource, type Config as StripeSourceConfig } from '@stripe/sync-source-stripe'
import destinationPostgres, {
  type Config as PostgresDestConfig,
} from '@stripe/sync-destination-postgres'
import type { ActivitiesContext } from './_shared.js'
import { log } from '../../logger.js'

export function createReconcileCleanupActivity(context: ActivitiesContext) {
  return async function reconcileCleanup(
    pipelineId: string,
    syncRunStartedAt: string
  ): Promise<void> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { source, destination, streams } = pipeline

    if (destination.type !== 'postgres' || source.type !== 'stripe') {
      // Only stripe→postgres is supported today.
      return
    }

    // Configs were validated against connector schemas at pipeline create time,
    // so the runtime shape matches the connector's strict Config type.
    const sourceConfig = source[source.type] as unknown as StripeSourceConfig
    const destConfig = destination[destination.type] as unknown as PostgresDestConfig

    const catalog = {
      streams:
        streams?.map((s) => ({
          stream: { name: s.name, newer_than_field: '_updated_at', primary_key: [['id']] },
          sync_mode: s.sync_mode || 'incremental',
          destination_sync_mode: 'append_dedup' as const,
        })) ?? [],
    }
    if (catalog.streams.length === 0) return

    // Restrict cleanup to records owned by this Stripe account so multi-tenant
    // schemas don't accidentally hard-delete rows that belong to a sibling sync.
    const filter = sourceConfig.account_id ? { _account_id: sourceConfig.account_id } : undefined
    if (!filter) {
      log.warn(
        { pipelineId },
        'reconcile_cleanup: source has no account_id — running unscoped (unsafe in multi-tenant schemas)'
      )
    }

    const stripeSource = createStripeSource()

    try {
      heartbeat({ phase: 'starting', pipelineId })

      // Wrap the destination's batches so we heartbeat per stream.
      async function* heartbeatedStaleRecords() {
        const inner = destinationPostgres.getStaleRecords!({
          config: destConfig,
          catalog,
          syncRunStartedAt,
          filter,
        })
        for await (const batch of inner) {
          heartbeat({ phase: 'verifying', stream: batch.stream, ids: batch.ids.length })
          yield batch
        }
      }

      const verificationMessages = stripeSource.verifyRecords!(
        { config: sourceConfig, catalog },
        heartbeatedStaleRecords()
      )

      const writeOutput = destinationPostgres.write(
        { config: destConfig, catalog },
        verificationMessages
      )

      let deleteCount = 0
      let lastHb = Date.now()
      for await (const m of writeOutput) {
        if (m.type === 'record' && m.record.recordDeleted) deleteCount++
        if (Date.now() - lastHb >= 15_000) {
          heartbeat({ phase: 'writing', deletes: deleteCount })
          lastHb = Date.now()
        }
      }

      log.info({ pipelineId, deleteCount, syncRunStartedAt }, 'reconcile_cleanup: completed')
    } catch (err) {
      // Cleanup is best-effort — log and swallow so the workflow's reconcile
      // loop keeps running on the next interval.
      log.error({ err, pipelineId, syncRunStartedAt }, 'reconcile_cleanup: failed')
    }
  }
}
