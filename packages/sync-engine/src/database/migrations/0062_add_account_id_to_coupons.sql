-- Add _account_id column to coupons table (missed in migration 0043)
ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;
