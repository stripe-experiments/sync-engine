-- Allow parallel sync runs per triggered_by (sigma-worker vs stripe-worker)
ALTER TABLE "stripe"."_sync_runs" DROP CONSTRAINT IF EXISTS one_active_run_per_account;
ALTER TABLE "stripe"."_sync_runs"
ADD CONSTRAINT one_active_run_per_account_triggered_by
EXCLUDE (
  "_account_id" WITH =,
  COALESCE(triggered_by, 'default') WITH =
) WHERE (closed_at IS NULL);
