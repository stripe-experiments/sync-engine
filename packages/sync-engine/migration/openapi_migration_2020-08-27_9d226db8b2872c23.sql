CREATE TABLE "stripe"."active_entitlements" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "customer" text GENERATED ALWAYS AS ((_raw_data->>'customer')::text) STORED,
  "feature" text GENERATED ALWAYS AS ((_raw_data->>'feature')::text) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "lookup_key" text GENERATED ALWAYS AS ((_raw_data->>'lookup_key')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS ((_raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "feature" text GENERATED ALWAYS AS ((_raw_data->>'feature')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "lookup_key" text GENERATED ALWAYS AS ((_raw_data->>'lookup_key')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" ADD CONSTRAINT "fk_active_entitlements_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_active_entitlements_account_id" ON "stripe"."active_entitlements" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."active_entitlements";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."active_entitlements" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."charges" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED,
  "amount_refunded" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_refunded', ''))::bigint) STORED,
  "application" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application') = 'object' AND _raw_data->'application' ? 'id'
        THEN (_raw_data->'application'->>'id')
      ELSE (_raw_data->>'application')
    END) STORED,
  "application_fee" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application_fee') = 'object' AND _raw_data->'application_fee' ? 'id'
        THEN (_raw_data->'application_fee'->>'id')
      ELSE (_raw_data->>'application_fee')
    END) STORED,
  "application_fee_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_amount', ''))::bigint) STORED,
  "balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'balance_transaction') = 'object' AND _raw_data->'balance_transaction' ? 'id'
        THEN (_raw_data->'balance_transaction'->>'id')
      ELSE (_raw_data->>'balance_transaction')
    END) STORED,
  "billing_details" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_details')::jsonb) STORED,
  "calculated_statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'calculated_statement_descriptor')::text) STORED,
  "captured" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'captured', ''))::boolean) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "disputed" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'disputed', ''))::boolean) STORED,
  "failure_code" text GENERATED ALWAYS AS ((_raw_data->>'failure_code')::text) STORED,
  "failure_message" text GENERATED ALWAYS AS ((_raw_data->>'failure_message')::text) STORED,
  "fraud_details" jsonb GENERATED ALWAYS AS ((_raw_data->'fraud_details')::jsonb) STORED,
  "invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'invoice') = 'object' AND _raw_data->'invoice' ? 'id'
        THEN (_raw_data->'invoice'->>'id')
      ELSE (_raw_data->>'invoice')
    END) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "on_behalf_of" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'on_behalf_of') = 'object' AND _raw_data->'on_behalf_of' ? 'id'
        THEN (_raw_data->'on_behalf_of'->>'id')
      ELSE (_raw_data->>'on_behalf_of')
    END) STORED,
  "order" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'order') = 'object' AND _raw_data->'order' ? 'id'
        THEN (_raw_data->'order'->>'id')
      ELSE (_raw_data->>'order')
    END) STORED,
  "outcome" jsonb GENERATED ALWAYS AS ((_raw_data->'outcome')::jsonb) STORED,
  "paid" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'paid', ''))::boolean) STORED,
  "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED,
  "payment_method" text GENERATED ALWAYS AS ((_raw_data->>'payment_method')::text) STORED,
  "payment_method_details" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_details')::jsonb) STORED,
  "receipt_email" text GENERATED ALWAYS AS ((_raw_data->>'receipt_email')::text) STORED,
  "receipt_number" text GENERATED ALWAYS AS ((_raw_data->>'receipt_number')::text) STORED,
  "receipt_url" text GENERATED ALWAYS AS ((_raw_data->>'receipt_url')::text) STORED,
  "refunded" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'refunded', ''))::boolean) STORED,
  "refunds" jsonb GENERATED ALWAYS AS ((_raw_data->'refunds')::jsonb) STORED,
  "review" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'review') = 'object' AND _raw_data->'review' ? 'id'
        THEN (_raw_data->'review'->>'id')
      ELSE (_raw_data->>'review')
    END) STORED,
  "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED,
  "source_transfer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'source_transfer') = 'object' AND _raw_data->'source_transfer' ? 'id'
        THEN (_raw_data->'source_transfer'->>'id')
      ELSE (_raw_data->>'source_transfer')
    END) STORED,
  "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED,
  "statement_descriptor_suffix" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor_suffix')::text) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "transfer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'transfer') = 'object' AND _raw_data->'transfer' ? 'id'
        THEN (_raw_data->'transfer'->>'id')
      ELSE (_raw_data->>'transfer')
    END) STORED,
  "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED,
  "transfer_group" text GENERATED ALWAYS AS ((_raw_data->>'transfer_group')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "amount_refunded" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_refunded', ''))::bigint) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "application" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application') = 'object' AND _raw_data->'application' ? 'id'
        THEN (_raw_data->'application'->>'id')
      ELSE (_raw_data->>'application')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "application_fee" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application_fee') = 'object' AND _raw_data->'application_fee' ? 'id'
        THEN (_raw_data->'application_fee'->>'id')
      ELSE (_raw_data->>'application_fee')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "application_fee_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'balance_transaction') = 'object' AND _raw_data->'balance_transaction' ? 'id'
        THEN (_raw_data->'balance_transaction'->>'id')
      ELSE (_raw_data->>'balance_transaction')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "billing_details" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_details')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "calculated_statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'calculated_statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "captured" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'captured', ''))::boolean) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "disputed" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'disputed', ''))::boolean) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "failure_code" text GENERATED ALWAYS AS ((_raw_data->>'failure_code')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "failure_message" text GENERATED ALWAYS AS ((_raw_data->>'failure_message')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "fraud_details" jsonb GENERATED ALWAYS AS ((_raw_data->'fraud_details')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'invoice') = 'object' AND _raw_data->'invoice' ? 'id'
        THEN (_raw_data->'invoice'->>'id')
      ELSE (_raw_data->>'invoice')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "on_behalf_of" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'on_behalf_of') = 'object' AND _raw_data->'on_behalf_of' ? 'id'
        THEN (_raw_data->'on_behalf_of'->>'id')
      ELSE (_raw_data->>'on_behalf_of')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "order" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'order') = 'object' AND _raw_data->'order' ? 'id'
        THEN (_raw_data->'order'->>'id')
      ELSE (_raw_data->>'order')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "outcome" jsonb GENERATED ALWAYS AS ((_raw_data->'outcome')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "paid" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'paid', ''))::boolean) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "payment_method" text GENERATED ALWAYS AS ((_raw_data->>'payment_method')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "payment_method_details" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_details')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "receipt_email" text GENERATED ALWAYS AS ((_raw_data->>'receipt_email')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "receipt_number" text GENERATED ALWAYS AS ((_raw_data->>'receipt_number')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "receipt_url" text GENERATED ALWAYS AS ((_raw_data->>'receipt_url')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "refunded" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'refunded', ''))::boolean) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "refunds" jsonb GENERATED ALWAYS AS ((_raw_data->'refunds')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "review" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'review') = 'object' AND _raw_data->'review' ? 'id'
        THEN (_raw_data->'review'->>'id')
      ELSE (_raw_data->>'review')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "source_transfer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'source_transfer') = 'object' AND _raw_data->'source_transfer' ? 'id'
        THEN (_raw_data->'source_transfer'->>'id')
      ELSE (_raw_data->>'source_transfer')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "statement_descriptor_suffix" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor_suffix')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "transfer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'transfer') = 'object' AND _raw_data->'transfer' ? 'id'
        THEN (_raw_data->'transfer'->>'id')
      ELSE (_raw_data->>'transfer')
    END) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "transfer_group" text GENERATED ALWAYS AS ((_raw_data->>'transfer_group')::text) STORED;

ALTER TABLE "stripe"."charges" ADD CONSTRAINT "fk_charges_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_charges_account_id" ON "stripe"."charges" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."charges";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."charges" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."checkout_session_line_items" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount_discount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_discount', ''))::bigint) STORED,
  "amount_subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_subtotal', ''))::bigint) STORED,
  "amount_tax" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_tax', ''))::bigint) STORED,
  "amount_total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_total', ''))::bigint) STORED,
  "checkout_session" text GENERATED ALWAYS AS ((_raw_data->>'checkout_session')::text) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "discounts" jsonb GENERATED ALWAYS AS ((_raw_data->'discounts')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "price" jsonb GENERATED ALWAYS AS ((_raw_data->'price')::jsonb) STORED,
  "quantity" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity', ''))::bigint) STORED,
  "taxes" jsonb GENERATED ALWAYS AS ((_raw_data->'taxes')::jsonb) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "amount_discount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_discount', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "amount_subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_subtotal', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "amount_tax" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_tax', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "amount_total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_total', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "checkout_session" text GENERATED ALWAYS AS ((_raw_data->>'checkout_session')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "discounts" jsonb GENERATED ALWAYS AS ((_raw_data->'discounts')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "price" jsonb GENERATED ALWAYS AS ((_raw_data->'price')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "quantity" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "taxes" jsonb GENERATED ALWAYS AS ((_raw_data->'taxes')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" ADD CONSTRAINT "fk_checkout_session_line_items_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_checkout_session_line_items_account_id" ON "stripe"."checkout_session_line_items" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."checkout_session_line_items";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."checkout_session_line_items" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."checkout_sessions" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "allow_promotion_codes" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'allow_promotion_codes', ''))::boolean) STORED,
  "amount_subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_subtotal', ''))::bigint) STORED,
  "amount_total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_total', ''))::bigint) STORED,
  "billing_address_collection" text GENERATED ALWAYS AS ((_raw_data->>'billing_address_collection')::text) STORED,
  "cancel_url" text GENERATED ALWAYS AS ((_raw_data->>'cancel_url')::text) STORED,
  "client_reference_id" text GENERATED ALWAYS AS ((_raw_data->>'client_reference_id')::text) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "customer_email" text GENERATED ALWAYS AS ((_raw_data->>'customer_email')::text) STORED,
  "line_items" jsonb GENERATED ALWAYS AS ((_raw_data->'line_items')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "locale" text GENERATED ALWAYS AS ((_raw_data->>'locale')::text) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "mode" text GENERATED ALWAYS AS ((_raw_data->>'mode')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED,
  "payment_method_types" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_types')::jsonb) STORED,
  "setup_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'setup_intent') = 'object' AND _raw_data->'setup_intent' ? 'id'
        THEN (_raw_data->'setup_intent'->>'id')
      ELSE (_raw_data->>'setup_intent')
    END) STORED,
  "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED,
  "shipping_address_collection" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping_address_collection')::jsonb) STORED,
  "submit_type" text GENERATED ALWAYS AS ((_raw_data->>'submit_type')::text) STORED,
  "subscription" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'subscription') = 'object' AND _raw_data->'subscription' ? 'id'
        THEN (_raw_data->'subscription'->>'id')
      ELSE (_raw_data->>'subscription')
    END) STORED,
  "success_url" text GENERATED ALWAYS AS ((_raw_data->>'success_url')::text) STORED,
  "total_details" jsonb GENERATED ALWAYS AS ((_raw_data->'total_details')::jsonb) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "allow_promotion_codes" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'allow_promotion_codes', ''))::boolean) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "amount_subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_subtotal', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "amount_total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_total', ''))::bigint) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "billing_address_collection" text GENERATED ALWAYS AS ((_raw_data->>'billing_address_collection')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "cancel_url" text GENERATED ALWAYS AS ((_raw_data->>'cancel_url')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "client_reference_id" text GENERATED ALWAYS AS ((_raw_data->>'client_reference_id')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "customer_email" text GENERATED ALWAYS AS ((_raw_data->>'customer_email')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "line_items" jsonb GENERATED ALWAYS AS ((_raw_data->'line_items')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "locale" text GENERATED ALWAYS AS ((_raw_data->>'locale')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "mode" text GENERATED ALWAYS AS ((_raw_data->>'mode')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "payment_method_types" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_types')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "setup_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'setup_intent') = 'object' AND _raw_data->'setup_intent' ? 'id'
        THEN (_raw_data->'setup_intent'->>'id')
      ELSE (_raw_data->>'setup_intent')
    END) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "shipping_address_collection" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping_address_collection')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "submit_type" text GENERATED ALWAYS AS ((_raw_data->>'submit_type')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "subscription" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'subscription') = 'object' AND _raw_data->'subscription' ? 'id'
        THEN (_raw_data->'subscription'->>'id')
      ELSE (_raw_data->>'subscription')
    END) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "success_url" text GENERATED ALWAYS AS ((_raw_data->>'success_url')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "total_details" jsonb GENERATED ALWAYS AS ((_raw_data->'total_details')::jsonb) STORED;

ALTER TABLE "stripe"."checkout_sessions" ADD CONSTRAINT "fk_checkout_sessions_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_checkout_sessions_account_id" ON "stripe"."checkout_sessions" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."checkout_sessions";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."checkout_sessions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."coupons" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount_off" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_off', ''))::bigint) STORED,
  "applies_to" jsonb GENERATED ALWAYS AS ((_raw_data->'applies_to')::jsonb) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "duration" text GENERATED ALWAYS AS ((_raw_data->>'duration')::text) STORED,
  "duration_in_months" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'duration_in_months', ''))::bigint) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "max_redemptions" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'max_redemptions', ''))::bigint) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "percent_off" numeric GENERATED ALWAYS AS ((NULLIF(_raw_data->>'percent_off', ''))::numeric) STORED,
  "redeem_by" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'redeem_by', ''))::bigint) STORED,
  "times_redeemed" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'times_redeemed', ''))::bigint) STORED,
  "valid" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'valid', ''))::boolean) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "amount_off" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_off', ''))::bigint) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "applies_to" jsonb GENERATED ALWAYS AS ((_raw_data->'applies_to')::jsonb) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "duration" text GENERATED ALWAYS AS ((_raw_data->>'duration')::text) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "duration_in_months" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'duration_in_months', ''))::bigint) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "max_redemptions" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'max_redemptions', ''))::bigint) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "percent_off" numeric GENERATED ALWAYS AS ((NULLIF(_raw_data->>'percent_off', ''))::numeric) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "redeem_by" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'redeem_by', ''))::bigint) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "times_redeemed" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'times_redeemed', ''))::bigint) STORED;

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "valid" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'valid', ''))::boolean) STORED;

ALTER TABLE "stripe"."coupons" ADD CONSTRAINT "fk_coupons_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_coupons_account_id" ON "stripe"."coupons" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."coupons";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."coupons" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."credit_notes" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "customer_balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer_balance_transaction') = 'object' AND _raw_data->'customer_balance_transaction' ? 'id'
        THEN (_raw_data->'customer_balance_transaction'->>'id')
      ELSE (_raw_data->>'customer_balance_transaction')
    END) STORED,
  "discount_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'discount_amount', ''))::bigint) STORED,
  "discount_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'discount_amounts')::jsonb) STORED,
  "invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'invoice') = 'object' AND _raw_data->'invoice' ? 'id'
        THEN (_raw_data->'invoice'->>'id')
      ELSE (_raw_data->>'invoice')
    END) STORED,
  "lines" jsonb GENERATED ALWAYS AS ((_raw_data->'lines')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "memo" text GENERATED ALWAYS AS ((_raw_data->>'memo')::text) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "number" text GENERATED ALWAYS AS ((_raw_data->>'number')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "out_of_band_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'out_of_band_amount', ''))::bigint) STORED,
  "pdf" text GENERATED ALWAYS AS ((_raw_data->>'pdf')::text) STORED,
  "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED,
  "refund" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'refund') = 'object' AND _raw_data->'refund' ? 'id'
        THEN (_raw_data->'refund'->>'id')
      ELSE (_raw_data->>'refund')
    END) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subtotal', ''))::bigint) STORED,
  "tax_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'tax_amounts')::jsonb) STORED,
  "total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'total', ''))::bigint) STORED,
  "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED,
  "voided_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'voided_at', ''))::bigint) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "customer_balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer_balance_transaction') = 'object' AND _raw_data->'customer_balance_transaction' ? 'id'
        THEN (_raw_data->'customer_balance_transaction'->>'id')
      ELSE (_raw_data->>'customer_balance_transaction')
    END) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "discount_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'discount_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "discount_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'discount_amounts')::jsonb) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'invoice') = 'object' AND _raw_data->'invoice' ? 'id'
        THEN (_raw_data->'invoice'->>'id')
      ELSE (_raw_data->>'invoice')
    END) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "lines" jsonb GENERATED ALWAYS AS ((_raw_data->'lines')::jsonb) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "memo" text GENERATED ALWAYS AS ((_raw_data->>'memo')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "number" text GENERATED ALWAYS AS ((_raw_data->>'number')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "out_of_band_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'out_of_band_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "pdf" text GENERATED ALWAYS AS ((_raw_data->>'pdf')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "refund" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'refund') = 'object' AND _raw_data->'refund' ? 'id'
        THEN (_raw_data->'refund'->>'id')
      ELSE (_raw_data->>'refund')
    END) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subtotal', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "tax_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'tax_amounts')::jsonb) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'total', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "voided_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'voided_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."credit_notes" ADD CONSTRAINT "fk_credit_notes_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_credit_notes_account_id" ON "stripe"."credit_notes" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."credit_notes";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."credit_notes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."customers" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "address" jsonb GENERATED ALWAYS AS ((_raw_data->'address')::jsonb) STORED,
  "balance" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'balance', ''))::bigint) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "default_source" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_source') = 'object' AND _raw_data->'default_source' ? 'id'
        THEN (_raw_data->'default_source'->>'id')
      ELSE (_raw_data->>'default_source')
    END) STORED,
  "deleted" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'deleted', ''))::boolean) STORED,
  "delinquent" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'delinquent', ''))::boolean) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "discount" jsonb GENERATED ALWAYS AS ((_raw_data->'discount')::jsonb) STORED,
  "email" text GENERATED ALWAYS AS ((_raw_data->>'email')::text) STORED,
  "invoice_prefix" text GENERATED ALWAYS AS ((_raw_data->>'invoice_prefix')::text) STORED,
  "invoice_settings" jsonb GENERATED ALWAYS AS ((_raw_data->'invoice_settings')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED,
  "next_invoice_sequence" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'next_invoice_sequence', ''))::bigint) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "phone" text GENERATED ALWAYS AS ((_raw_data->>'phone')::text) STORED,
  "preferred_locales" jsonb GENERATED ALWAYS AS ((_raw_data->'preferred_locales')::jsonb) STORED,
  "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED,
  "sources" jsonb GENERATED ALWAYS AS ((_raw_data->'sources')::jsonb) STORED,
  "subscriptions" jsonb GENERATED ALWAYS AS ((_raw_data->'subscriptions')::jsonb) STORED,
  "tax_exempt" text GENERATED ALWAYS AS ((_raw_data->>'tax_exempt')::text) STORED,
  "tax_ids" jsonb GENERATED ALWAYS AS ((_raw_data->'tax_ids')::jsonb) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "address" jsonb GENERATED ALWAYS AS ((_raw_data->'address')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "balance" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'balance', ''))::bigint) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "default_source" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_source') = 'object' AND _raw_data->'default_source' ? 'id'
        THEN (_raw_data->'default_source'->>'id')
      ELSE (_raw_data->>'default_source')
    END) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "deleted" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'deleted', ''))::boolean) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "delinquent" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'delinquent', ''))::boolean) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "discount" jsonb GENERATED ALWAYS AS ((_raw_data->'discount')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "email" text GENERATED ALWAYS AS ((_raw_data->>'email')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "invoice_prefix" text GENERATED ALWAYS AS ((_raw_data->>'invoice_prefix')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "invoice_settings" jsonb GENERATED ALWAYS AS ((_raw_data->'invoice_settings')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "next_invoice_sequence" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'next_invoice_sequence', ''))::bigint) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "phone" text GENERATED ALWAYS AS ((_raw_data->>'phone')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "preferred_locales" jsonb GENERATED ALWAYS AS ((_raw_data->'preferred_locales')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "sources" jsonb GENERATED ALWAYS AS ((_raw_data->'sources')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "subscriptions" jsonb GENERATED ALWAYS AS ((_raw_data->'subscriptions')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "tax_exempt" text GENERATED ALWAYS AS ((_raw_data->>'tax_exempt')::text) STORED;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "tax_ids" jsonb GENERATED ALWAYS AS ((_raw_data->'tax_ids')::jsonb) STORED;

ALTER TABLE "stripe"."customers" ADD CONSTRAINT "fk_customers_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_customers_account_id" ON "stripe"."customers" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."customers";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."customers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."disputes" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED,
  "balance_transactions" jsonb GENERATED ALWAYS AS ((_raw_data->'balance_transactions')::jsonb) STORED,
  "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "evidence" jsonb GENERATED ALWAYS AS ((_raw_data->'evidence')::jsonb) STORED,
  "evidence_details" jsonb GENERATED ALWAYS AS ((_raw_data->'evidence_details')::jsonb) STORED,
  "is_charge_refundable" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'is_charge_refundable', ''))::boolean) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED,
  "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "balance_transactions" jsonb GENERATED ALWAYS AS ((_raw_data->'balance_transactions')::jsonb) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "evidence" jsonb GENERATED ALWAYS AS ((_raw_data->'evidence')::jsonb) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "evidence_details" jsonb GENERATED ALWAYS AS ((_raw_data->'evidence_details')::jsonb) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "is_charge_refundable" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'is_charge_refundable', ''))::boolean) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."disputes" ADD CONSTRAINT "fk_disputes_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_disputes_account_id" ON "stripe"."disputes" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."disputes";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."disputes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."early_fraud_warnings" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "actionable" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'actionable', ''))::boolean) STORED,
  "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "fraud_type" text GENERATED ALWAYS AS ((_raw_data->>'fraud_type')::text) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "payment_intent" text GENERATED ALWAYS AS ((_raw_data->>'payment_intent')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "actionable" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'actionable', ''))::boolean) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "fraud_type" text GENERATED ALWAYS AS ((_raw_data->>'fraud_type')::text) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS ((_raw_data->>'payment_intent')::text) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" ADD CONSTRAINT "fk_early_fraud_warnings_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_early_fraud_warnings_account_id" ON "stripe"."early_fraud_warnings" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."early_fraud_warnings";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."early_fraud_warnings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."features" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "lookup_key" text GENERATED ALWAYS AS ((_raw_data->>'lookup_key')::text) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED;

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "lookup_key" text GENERATED ALWAYS AS ((_raw_data->>'lookup_key')::text) STORED;

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."features" ADD CONSTRAINT "fk_features_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_features_account_id" ON "stripe"."features" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."features";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."features" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."invoices" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "account_country" text GENERATED ALWAYS AS ((_raw_data->>'account_country')::text) STORED,
  "account_name" text GENERATED ALWAYS AS ((_raw_data->>'account_name')::text) STORED,
  "amount_due" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_due', ''))::bigint) STORED,
  "amount_paid" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_paid', ''))::bigint) STORED,
  "amount_remaining" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_remaining', ''))::bigint) STORED,
  "application_fee_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_amount', ''))::bigint) STORED,
  "attempt_count" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'attempt_count', ''))::bigint) STORED,
  "attempted" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'attempted', ''))::boolean) STORED,
  "auto_advance" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'auto_advance', ''))::boolean) STORED,
  "billing_reason" text GENERATED ALWAYS AS ((_raw_data->>'billing_reason')::text) STORED,
  "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED,
  "collection_method" text GENERATED ALWAYS AS ((_raw_data->>'collection_method')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "custom_fields" jsonb GENERATED ALWAYS AS ((_raw_data->'custom_fields')::jsonb) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "customer_address" jsonb GENERATED ALWAYS AS ((_raw_data->'customer_address')::jsonb) STORED,
  "customer_email" text GENERATED ALWAYS AS ((_raw_data->>'customer_email')::text) STORED,
  "customer_name" text GENERATED ALWAYS AS ((_raw_data->>'customer_name')::text) STORED,
  "customer_phone" text GENERATED ALWAYS AS ((_raw_data->>'customer_phone')::text) STORED,
  "customer_shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'customer_shipping')::jsonb) STORED,
  "customer_tax_exempt" text GENERATED ALWAYS AS ((_raw_data->>'customer_tax_exempt')::text) STORED,
  "customer_tax_ids" jsonb GENERATED ALWAYS AS ((_raw_data->'customer_tax_ids')::jsonb) STORED,
  "default_payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_payment_method') = 'object' AND _raw_data->'default_payment_method' ? 'id'
        THEN (_raw_data->'default_payment_method'->>'id')
      ELSE (_raw_data->>'default_payment_method')
    END) STORED,
  "default_source" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_source') = 'object' AND _raw_data->'default_source' ? 'id'
        THEN (_raw_data->'default_source'->>'id')
      ELSE (_raw_data->>'default_source')
    END) STORED,
  "default_tax_rates" jsonb GENERATED ALWAYS AS ((_raw_data->'default_tax_rates')::jsonb) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "discount" jsonb GENERATED ALWAYS AS ((_raw_data->'discount')::jsonb) STORED,
  "discounts" jsonb GENERATED ALWAYS AS ((_raw_data->'discounts')::jsonb) STORED,
  "due_date" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'due_date', ''))::bigint) STORED,
  "ending_balance" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'ending_balance', ''))::bigint) STORED,
  "footer" text GENERATED ALWAYS AS ((_raw_data->>'footer')::text) STORED,
  "hosted_invoice_url" text GENERATED ALWAYS AS ((_raw_data->>'hosted_invoice_url')::text) STORED,
  "invoice_pdf" text GENERATED ALWAYS AS ((_raw_data->>'invoice_pdf')::text) STORED,
  "lines" jsonb GENERATED ALWAYS AS ((_raw_data->'lines')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "next_payment_attempt" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'next_payment_attempt', ''))::bigint) STORED,
  "number" text GENERATED ALWAYS AS ((_raw_data->>'number')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "paid" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'paid', ''))::boolean) STORED,
  "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED,
  "period_end" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'period_end', ''))::bigint) STORED,
  "period_start" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'period_start', ''))::bigint) STORED,
  "post_payment_credit_notes_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'post_payment_credit_notes_amount', ''))::bigint) STORED,
  "pre_payment_credit_notes_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'pre_payment_credit_notes_amount', ''))::bigint) STORED,
  "receipt_number" text GENERATED ALWAYS AS ((_raw_data->>'receipt_number')::text) STORED,
  "starting_balance" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'starting_balance', ''))::bigint) STORED,
  "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "status_transitions" jsonb GENERATED ALWAYS AS ((_raw_data->'status_transitions')::jsonb) STORED,
  "subscription" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'subscription') = 'object' AND _raw_data->'subscription' ? 'id'
        THEN (_raw_data->'subscription'->>'id')
      ELSE (_raw_data->>'subscription')
    END) STORED,
  "subscription_proration_date" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subscription_proration_date', ''))::bigint) STORED,
  "subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subtotal', ''))::bigint) STORED,
  "tax" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'tax', ''))::bigint) STORED,
  "threshold_reason" jsonb GENERATED ALWAYS AS ((_raw_data->'threshold_reason')::jsonb) STORED,
  "total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'total', ''))::bigint) STORED,
  "total_discount_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'total_discount_amounts')::jsonb) STORED,
  "total_tax_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'total_tax_amounts')::jsonb) STORED,
  "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED,
  "webhooks_delivered_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'webhooks_delivered_at', ''))::bigint) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "account_country" text GENERATED ALWAYS AS ((_raw_data->>'account_country')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "account_name" text GENERATED ALWAYS AS ((_raw_data->>'account_name')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "amount_due" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_due', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "amount_paid" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_paid', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "amount_remaining" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_remaining', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "application_fee_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "attempt_count" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'attempt_count', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "attempted" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'attempted', ''))::boolean) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "auto_advance" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'auto_advance', ''))::boolean) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "billing_reason" text GENERATED ALWAYS AS ((_raw_data->>'billing_reason')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "collection_method" text GENERATED ALWAYS AS ((_raw_data->>'collection_method')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb GENERATED ALWAYS AS ((_raw_data->'custom_fields')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_address" jsonb GENERATED ALWAYS AS ((_raw_data->'customer_address')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_email" text GENERATED ALWAYS AS ((_raw_data->>'customer_email')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_name" text GENERATED ALWAYS AS ((_raw_data->>'customer_name')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_phone" text GENERATED ALWAYS AS ((_raw_data->>'customer_phone')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'customer_shipping')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_tax_exempt" text GENERATED ALWAYS AS ((_raw_data->>'customer_tax_exempt')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "customer_tax_ids" jsonb GENERATED ALWAYS AS ((_raw_data->'customer_tax_ids')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "default_payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_payment_method') = 'object' AND _raw_data->'default_payment_method' ? 'id'
        THEN (_raw_data->'default_payment_method'->>'id')
      ELSE (_raw_data->>'default_payment_method')
    END) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "default_source" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_source') = 'object' AND _raw_data->'default_source' ? 'id'
        THEN (_raw_data->'default_source'->>'id')
      ELSE (_raw_data->>'default_source')
    END) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "default_tax_rates" jsonb GENERATED ALWAYS AS ((_raw_data->'default_tax_rates')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "discount" jsonb GENERATED ALWAYS AS ((_raw_data->'discount')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "discounts" jsonb GENERATED ALWAYS AS ((_raw_data->'discounts')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "due_date" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'due_date', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "ending_balance" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'ending_balance', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "footer" text GENERATED ALWAYS AS ((_raw_data->>'footer')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "hosted_invoice_url" text GENERATED ALWAYS AS ((_raw_data->>'hosted_invoice_url')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "invoice_pdf" text GENERATED ALWAYS AS ((_raw_data->>'invoice_pdf')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "lines" jsonb GENERATED ALWAYS AS ((_raw_data->'lines')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "next_payment_attempt" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'next_payment_attempt', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "number" text GENERATED ALWAYS AS ((_raw_data->>'number')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "paid" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'paid', ''))::boolean) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "period_end" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'period_end', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "period_start" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'period_start', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "post_payment_credit_notes_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'post_payment_credit_notes_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "pre_payment_credit_notes_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'pre_payment_credit_notes_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "receipt_number" text GENERATED ALWAYS AS ((_raw_data->>'receipt_number')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "starting_balance" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'starting_balance', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "status_transitions" jsonb GENERATED ALWAYS AS ((_raw_data->'status_transitions')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "subscription" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'subscription') = 'object' AND _raw_data->'subscription' ? 'id'
        THEN (_raw_data->'subscription'->>'id')
      ELSE (_raw_data->>'subscription')
    END) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "subscription_proration_date" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subscription_proration_date', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "subtotal" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subtotal', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "tax" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'tax', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "threshold_reason" jsonb GENERATED ALWAYS AS ((_raw_data->'threshold_reason')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "total" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'total', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "total_discount_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'total_discount_amounts')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "total_tax_amounts" jsonb GENERATED ALWAYS AS ((_raw_data->'total_tax_amounts')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "webhooks_delivered_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'webhooks_delivered_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."invoices" ADD CONSTRAINT "fk_invoices_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_invoices_account_id" ON "stripe"."invoices" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."invoices";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."invoices" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."payment_intents" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED,
  "amount_capturable" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_capturable', ''))::bigint) STORED,
  "amount_received" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_received', ''))::bigint) STORED,
  "application" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application') = 'object' AND _raw_data->'application' ? 'id'
        THEN (_raw_data->'application'->>'id')
      ELSE (_raw_data->>'application')
    END) STORED,
  "application_fee_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_amount', ''))::bigint) STORED,
  "canceled_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'canceled_at', ''))::bigint) STORED,
  "cancellation_reason" text GENERATED ALWAYS AS ((_raw_data->>'cancellation_reason')::text) STORED,
  "capture_method" text GENERATED ALWAYS AS ((_raw_data->>'capture_method')::text) STORED,
  "charges" jsonb GENERATED ALWAYS AS ((_raw_data->'charges')::jsonb) STORED,
  "client_secret" text GENERATED ALWAYS AS ((_raw_data->>'client_secret')::text) STORED,
  "confirmation_method" text GENERATED ALWAYS AS ((_raw_data->>'confirmation_method')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'invoice') = 'object' AND _raw_data->'invoice' ? 'id'
        THEN (_raw_data->'invoice'->>'id')
      ELSE (_raw_data->>'invoice')
    END) STORED,
  "last_payment_error" jsonb GENERATED ALWAYS AS ((_raw_data->'last_payment_error')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "next_action" jsonb GENERATED ALWAYS AS ((_raw_data->'next_action')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "on_behalf_of" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'on_behalf_of') = 'object' AND _raw_data->'on_behalf_of' ? 'id'
        THEN (_raw_data->'on_behalf_of'->>'id')
      ELSE (_raw_data->>'on_behalf_of')
    END) STORED,
  "payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_method') = 'object' AND _raw_data->'payment_method' ? 'id'
        THEN (_raw_data->'payment_method'->>'id')
      ELSE (_raw_data->>'payment_method')
    END) STORED,
  "payment_method_options" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_options')::jsonb) STORED,
  "payment_method_types" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_types')::jsonb) STORED,
  "receipt_email" text GENERATED ALWAYS AS ((_raw_data->>'receipt_email')::text) STORED,
  "review" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'review') = 'object' AND _raw_data->'review' ? 'id'
        THEN (_raw_data->'review'->>'id')
      ELSE (_raw_data->>'review')
    END) STORED,
  "setup_future_usage" text GENERATED ALWAYS AS ((_raw_data->>'setup_future_usage')::text) STORED,
  "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED,
  "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED,
  "statement_descriptor_suffix" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor_suffix')::text) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED,
  "transfer_group" text GENERATED ALWAYS AS ((_raw_data->>'transfer_group')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "amount_capturable" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_capturable', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "amount_received" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount_received', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "application" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application') = 'object' AND _raw_data->'application' ? 'id'
        THEN (_raw_data->'application'->>'id')
      ELSE (_raw_data->>'application')
    END) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "application_fee_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "canceled_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'canceled_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "cancellation_reason" text GENERATED ALWAYS AS ((_raw_data->>'cancellation_reason')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "capture_method" text GENERATED ALWAYS AS ((_raw_data->>'capture_method')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "charges" jsonb GENERATED ALWAYS AS ((_raw_data->'charges')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "client_secret" text GENERATED ALWAYS AS ((_raw_data->>'client_secret')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "confirmation_method" text GENERATED ALWAYS AS ((_raw_data->>'confirmation_method')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'invoice') = 'object' AND _raw_data->'invoice' ? 'id'
        THEN (_raw_data->'invoice'->>'id')
      ELSE (_raw_data->>'invoice')
    END) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "last_payment_error" jsonb GENERATED ALWAYS AS ((_raw_data->'last_payment_error')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "next_action" jsonb GENERATED ALWAYS AS ((_raw_data->'next_action')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "on_behalf_of" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'on_behalf_of') = 'object' AND _raw_data->'on_behalf_of' ? 'id'
        THEN (_raw_data->'on_behalf_of'->>'id')
      ELSE (_raw_data->>'on_behalf_of')
    END) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_method') = 'object' AND _raw_data->'payment_method' ? 'id'
        THEN (_raw_data->'payment_method'->>'id')
      ELSE (_raw_data->>'payment_method')
    END) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "payment_method_options" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_options')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "payment_method_types" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_types')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "receipt_email" text GENERATED ALWAYS AS ((_raw_data->>'receipt_email')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "review" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'review') = 'object' AND _raw_data->'review' ? 'id'
        THEN (_raw_data->'review'->>'id')
      ELSE (_raw_data->>'review')
    END) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "setup_future_usage" text GENERATED ALWAYS AS ((_raw_data->>'setup_future_usage')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "shipping" jsonb GENERATED ALWAYS AS ((_raw_data->'shipping')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "statement_descriptor_suffix" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor_suffix')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "transfer_group" text GENERATED ALWAYS AS ((_raw_data->>'transfer_group')::text) STORED;

ALTER TABLE "stripe"."payment_intents" ADD CONSTRAINT "fk_payment_intents_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_payment_intents_account_id" ON "stripe"."payment_intents" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."payment_intents";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."payment_intents" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."payment_methods" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "alipay" jsonb GENERATED ALWAYS AS ((_raw_data->'alipay')::jsonb) STORED,
  "au_becs_debit" jsonb GENERATED ALWAYS AS ((_raw_data->'au_becs_debit')::jsonb) STORED,
  "bacs_debit" jsonb GENERATED ALWAYS AS ((_raw_data->'bacs_debit')::jsonb) STORED,
  "bancontact" jsonb GENERATED ALWAYS AS ((_raw_data->'bancontact')::jsonb) STORED,
  "billing_details" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_details')::jsonb) STORED,
  "card" jsonb GENERATED ALWAYS AS ((_raw_data->'card')::jsonb) STORED,
  "card_present" jsonb GENERATED ALWAYS AS ((_raw_data->'card_present')::jsonb) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "eps" jsonb GENERATED ALWAYS AS ((_raw_data->'eps')::jsonb) STORED,
  "fpx" jsonb GENERATED ALWAYS AS ((_raw_data->'fpx')::jsonb) STORED,
  "giropay" jsonb GENERATED ALWAYS AS ((_raw_data->'giropay')::jsonb) STORED,
  "ideal" jsonb GENERATED ALWAYS AS ((_raw_data->'ideal')::jsonb) STORED,
  "interac_present" jsonb GENERATED ALWAYS AS ((_raw_data->'interac_present')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "p24" jsonb GENERATED ALWAYS AS ((_raw_data->'p24')::jsonb) STORED,
  "sepa_debit" jsonb GENERATED ALWAYS AS ((_raw_data->'sepa_debit')::jsonb) STORED,
  "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "alipay" jsonb GENERATED ALWAYS AS ((_raw_data->'alipay')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "au_becs_debit" jsonb GENERATED ALWAYS AS ((_raw_data->'au_becs_debit')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "bacs_debit" jsonb GENERATED ALWAYS AS ((_raw_data->'bacs_debit')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "bancontact" jsonb GENERATED ALWAYS AS ((_raw_data->'bancontact')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "billing_details" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_details')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "card" jsonb GENERATED ALWAYS AS ((_raw_data->'card')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "card_present" jsonb GENERATED ALWAYS AS ((_raw_data->'card_present')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "eps" jsonb GENERATED ALWAYS AS ((_raw_data->'eps')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "fpx" jsonb GENERATED ALWAYS AS ((_raw_data->'fpx')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "giropay" jsonb GENERATED ALWAYS AS ((_raw_data->'giropay')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "ideal" jsonb GENERATED ALWAYS AS ((_raw_data->'ideal')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "interac_present" jsonb GENERATED ALWAYS AS ((_raw_data->'interac_present')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "p24" jsonb GENERATED ALWAYS AS ((_raw_data->'p24')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "sepa_debit" jsonb GENERATED ALWAYS AS ((_raw_data->'sepa_debit')::jsonb) STORED;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."payment_methods" ADD CONSTRAINT "fk_payment_methods_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_payment_methods_account_id" ON "stripe"."payment_methods" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."payment_methods";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."payment_methods" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."plans" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED,
  "aggregate_usage" text GENERATED ALWAYS AS ((_raw_data->>'aggregate_usage')::text) STORED,
  "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED,
  "amount_decimal" text GENERATED ALWAYS AS ((_raw_data->>'amount_decimal')::text) STORED,
  "billing_scheme" text GENERATED ALWAYS AS ((_raw_data->>'billing_scheme')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "interval" text GENERATED ALWAYS AS ((_raw_data->>'interval')::text) STORED,
  "interval_count" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'interval_count', ''))::bigint) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "nickname" text GENERATED ALWAYS AS ((_raw_data->>'nickname')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "product" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'product') = 'object' AND _raw_data->'product' ? 'id'
        THEN (_raw_data->'product'->>'id')
      ELSE (_raw_data->>'product')
    END) STORED,
  "tiers" jsonb GENERATED ALWAYS AS ((_raw_data->'tiers')::jsonb) STORED,
  "tiers_mode" text GENERATED ALWAYS AS ((_raw_data->>'tiers_mode')::text) STORED,
  "transform_usage" jsonb GENERATED ALWAYS AS ((_raw_data->'transform_usage')::jsonb) STORED,
  "trial_period_days" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'trial_period_days', ''))::bigint) STORED,
  "usage_type" text GENERATED ALWAYS AS ((_raw_data->>'usage_type')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "aggregate_usage" text GENERATED ALWAYS AS ((_raw_data->>'aggregate_usage')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "amount_decimal" text GENERATED ALWAYS AS ((_raw_data->>'amount_decimal')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "billing_scheme" text GENERATED ALWAYS AS ((_raw_data->>'billing_scheme')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "interval" text GENERATED ALWAYS AS ((_raw_data->>'interval')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "interval_count" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'interval_count', ''))::bigint) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "nickname" text GENERATED ALWAYS AS ((_raw_data->>'nickname')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "product" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'product') = 'object' AND _raw_data->'product' ? 'id'
        THEN (_raw_data->'product'->>'id')
      ELSE (_raw_data->>'product')
    END) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "tiers" jsonb GENERATED ALWAYS AS ((_raw_data->'tiers')::jsonb) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "tiers_mode" text GENERATED ALWAYS AS ((_raw_data->>'tiers_mode')::text) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "transform_usage" jsonb GENERATED ALWAYS AS ((_raw_data->'transform_usage')::jsonb) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "trial_period_days" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'trial_period_days', ''))::bigint) STORED;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "usage_type" text GENERATED ALWAYS AS ((_raw_data->>'usage_type')::text) STORED;

ALTER TABLE "stripe"."plans" ADD CONSTRAINT "fk_plans_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_plans_account_id" ON "stripe"."plans" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."plans";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."plans" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."prices" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED,
  "billing_scheme" text GENERATED ALWAYS AS ((_raw_data->>'billing_scheme')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "lookup_key" text GENERATED ALWAYS AS ((_raw_data->>'lookup_key')::text) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "nickname" text GENERATED ALWAYS AS ((_raw_data->>'nickname')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "product" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'product') = 'object' AND _raw_data->'product' ? 'id'
        THEN (_raw_data->'product'->>'id')
      ELSE (_raw_data->>'product')
    END) STORED,
  "recurring" jsonb GENERATED ALWAYS AS ((_raw_data->'recurring')::jsonb) STORED,
  "tiers" jsonb GENERATED ALWAYS AS ((_raw_data->'tiers')::jsonb) STORED,
  "tiers_mode" text GENERATED ALWAYS AS ((_raw_data->>'tiers_mode')::text) STORED,
  "transform_quantity" jsonb GENERATED ALWAYS AS ((_raw_data->'transform_quantity')::jsonb) STORED,
  "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED,
  "unit_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'unit_amount', ''))::bigint) STORED,
  "unit_amount_decimal" text GENERATED ALWAYS AS ((_raw_data->>'unit_amount_decimal')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "billing_scheme" text GENERATED ALWAYS AS ((_raw_data->>'billing_scheme')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "lookup_key" text GENERATED ALWAYS AS ((_raw_data->>'lookup_key')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "nickname" text GENERATED ALWAYS AS ((_raw_data->>'nickname')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "product" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'product') = 'object' AND _raw_data->'product' ? 'id'
        THEN (_raw_data->'product'->>'id')
      ELSE (_raw_data->>'product')
    END) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "recurring" jsonb GENERATED ALWAYS AS ((_raw_data->'recurring')::jsonb) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "tiers" jsonb GENERATED ALWAYS AS ((_raw_data->'tiers')::jsonb) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "tiers_mode" text GENERATED ALWAYS AS ((_raw_data->>'tiers_mode')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "transform_quantity" jsonb GENERATED ALWAYS AS ((_raw_data->'transform_quantity')::jsonb) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "unit_amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'unit_amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "unit_amount_decimal" text GENERATED ALWAYS AS ((_raw_data->>'unit_amount_decimal')::text) STORED;

ALTER TABLE "stripe"."prices" ADD CONSTRAINT "fk_prices_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_prices_account_id" ON "stripe"."prices" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."prices";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."prices" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."products" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED,
  "attributes" jsonb GENERATED ALWAYS AS ((_raw_data->'attributes')::jsonb) STORED,
  "caption" text GENERATED ALWAYS AS ((_raw_data->>'caption')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "deactivate_on" jsonb GENERATED ALWAYS AS ((_raw_data->'deactivate_on')::jsonb) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "images" jsonb GENERATED ALWAYS AS ((_raw_data->'images')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "package_dimensions" jsonb GENERATED ALWAYS AS ((_raw_data->'package_dimensions')::jsonb) STORED,
  "shippable" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'shippable', ''))::boolean) STORED,
  "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED,
  "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED,
  "unit_label" text GENERATED ALWAYS AS ((_raw_data->>'unit_label')::text) STORED,
  "updated" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'updated', ''))::bigint) STORED,
  "url" text GENERATED ALWAYS AS ((_raw_data->>'url')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "active" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'active', ''))::boolean) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "attributes" jsonb GENERATED ALWAYS AS ((_raw_data->'attributes')::jsonb) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "caption" text GENERATED ALWAYS AS ((_raw_data->>'caption')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "deactivate_on" jsonb GENERATED ALWAYS AS ((_raw_data->'deactivate_on')::jsonb) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "images" jsonb GENERATED ALWAYS AS ((_raw_data->'images')::jsonb) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "name" text GENERATED ALWAYS AS ((_raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "package_dimensions" jsonb GENERATED ALWAYS AS ((_raw_data->'package_dimensions')::jsonb) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "shippable" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'shippable', ''))::boolean) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "statement_descriptor" text GENERATED ALWAYS AS ((_raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "unit_label" text GENERATED ALWAYS AS ((_raw_data->>'unit_label')::text) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "updated" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'updated', ''))::bigint) STORED;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "url" text GENERATED ALWAYS AS ((_raw_data->>'url')::text) STORED;

ALTER TABLE "stripe"."products" ADD CONSTRAINT "fk_products_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_products_account_id" ON "stripe"."products" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."products";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."products" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."refunds" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED,
  "balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'balance_transaction') = 'object' AND _raw_data->'balance_transaction' ? 'id'
        THEN (_raw_data->'balance_transaction'->>'id')
      ELSE (_raw_data->>'balance_transaction')
    END) STORED,
  "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "failure_balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'failure_balance_transaction') = 'object' AND _raw_data->'failure_balance_transaction' ? 'id'
        THEN (_raw_data->'failure_balance_transaction'->>'id')
      ELSE (_raw_data->>'failure_balance_transaction')
    END) STORED,
  "failure_reason" text GENERATED ALWAYS AS ((_raw_data->>'failure_reason')::text) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED,
  "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED,
  "receipt_number" text GENERATED ALWAYS AS ((_raw_data->>'receipt_number')::text) STORED,
  "source_transfer_reversal" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'source_transfer_reversal') = 'object' AND _raw_data->'source_transfer_reversal' ? 'id'
        THEN (_raw_data->'source_transfer_reversal'->>'id')
      ELSE (_raw_data->>'source_transfer_reversal')
    END) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "transfer_reversal" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'transfer_reversal') = 'object' AND _raw_data->'transfer_reversal' ? 'id'
        THEN (_raw_data->'transfer_reversal'->>'id')
      ELSE (_raw_data->>'transfer_reversal')
    END) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "amount" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'amount', ''))::bigint) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'balance_transaction') = 'object' AND _raw_data->'balance_transaction' ? 'id'
        THEN (_raw_data->'balance_transaction'->>'id')
      ELSE (_raw_data->>'balance_transaction')
    END) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "currency" text GENERATED ALWAYS AS ((_raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "failure_balance_transaction" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'failure_balance_transaction') = 'object' AND _raw_data->'failure_balance_transaction' ? 'id'
        THEN (_raw_data->'failure_balance_transaction'->>'id')
      ELSE (_raw_data->>'failure_balance_transaction')
    END) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "failure_reason" text GENERATED ALWAYS AS ((_raw_data->>'failure_reason')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "receipt_number" text GENERATED ALWAYS AS ((_raw_data->>'receipt_number')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "source_transfer_reversal" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'source_transfer_reversal') = 'object' AND _raw_data->'source_transfer_reversal' ? 'id'
        THEN (_raw_data->'source_transfer_reversal'->>'id')
      ELSE (_raw_data->>'source_transfer_reversal')
    END) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "transfer_reversal" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'transfer_reversal') = 'object' AND _raw_data->'transfer_reversal' ? 'id'
        THEN (_raw_data->'transfer_reversal'->>'id')
      ELSE (_raw_data->>'transfer_reversal')
    END) STORED;

ALTER TABLE "stripe"."refunds" ADD CONSTRAINT "fk_refunds_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_refunds_account_id" ON "stripe"."refunds" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."refunds";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."refunds" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."reviews" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "billing_zip" text GENERATED ALWAYS AS ((_raw_data->>'billing_zip')::text) STORED,
  "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED,
  "closed_reason" text GENERATED ALWAYS AS ((_raw_data->>'closed_reason')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "ip_address" text GENERATED ALWAYS AS ((_raw_data->>'ip_address')::text) STORED,
  "ip_address_location" jsonb GENERATED ALWAYS AS ((_raw_data->'ip_address_location')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "open" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'open', ''))::boolean) STORED,
  "opened_reason" text GENERATED ALWAYS AS ((_raw_data->>'opened_reason')::text) STORED,
  "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED,
  "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED,
  "session" jsonb GENERATED ALWAYS AS ((_raw_data->'session')::jsonb) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "billing_zip" text GENERATED ALWAYS AS ((_raw_data->>'billing_zip')::text) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "charge" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'charge') = 'object' AND _raw_data->'charge' ? 'id'
        THEN (_raw_data->'charge'->>'id')
      ELSE (_raw_data->>'charge')
    END) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "closed_reason" text GENERATED ALWAYS AS ((_raw_data->>'closed_reason')::text) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "ip_address" text GENERATED ALWAYS AS ((_raw_data->>'ip_address')::text) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "ip_address_location" jsonb GENERATED ALWAYS AS ((_raw_data->'ip_address_location')::jsonb) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "open" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'open', ''))::boolean) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "opened_reason" text GENERATED ALWAYS AS ((_raw_data->>'opened_reason')::text) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "payment_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_intent') = 'object' AND _raw_data->'payment_intent' ? 'id'
        THEN (_raw_data->'payment_intent'->>'id')
      ELSE (_raw_data->>'payment_intent')
    END) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "reason" text GENERATED ALWAYS AS ((_raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "session" jsonb GENERATED ALWAYS AS ((_raw_data->'session')::jsonb) STORED;

ALTER TABLE "stripe"."reviews" ADD CONSTRAINT "fk_reviews_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_reviews_account_id" ON "stripe"."reviews" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."reviews";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."reviews" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."setup_intents" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "application" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application') = 'object' AND _raw_data->'application' ? 'id'
        THEN (_raw_data->'application'->>'id')
      ELSE (_raw_data->>'application')
    END) STORED,
  "cancellation_reason" text GENERATED ALWAYS AS ((_raw_data->>'cancellation_reason')::text) STORED,
  "client_secret" text GENERATED ALWAYS AS ((_raw_data->>'client_secret')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED,
  "last_setup_error" jsonb GENERATED ALWAYS AS ((_raw_data->'last_setup_error')::jsonb) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "mandate" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'mandate') = 'object' AND _raw_data->'mandate' ? 'id'
        THEN (_raw_data->'mandate'->>'id')
      ELSE (_raw_data->>'mandate')
    END) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "next_action" jsonb GENERATED ALWAYS AS ((_raw_data->'next_action')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "on_behalf_of" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'on_behalf_of') = 'object' AND _raw_data->'on_behalf_of' ? 'id'
        THEN (_raw_data->'on_behalf_of'->>'id')
      ELSE (_raw_data->>'on_behalf_of')
    END) STORED,
  "payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_method') = 'object' AND _raw_data->'payment_method' ? 'id'
        THEN (_raw_data->'payment_method'->>'id')
      ELSE (_raw_data->>'payment_method')
    END) STORED,
  "payment_method_options" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_options')::jsonb) STORED,
  "payment_method_types" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_types')::jsonb) STORED,
  "single_use_mandate" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'single_use_mandate') = 'object' AND _raw_data->'single_use_mandate' ? 'id'
        THEN (_raw_data->'single_use_mandate'->>'id')
      ELSE (_raw_data->>'single_use_mandate')
    END) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "usage" text GENERATED ALWAYS AS ((_raw_data->>'usage')::text) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "application" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'application') = 'object' AND _raw_data->'application' ? 'id'
        THEN (_raw_data->'application'->>'id')
      ELSE (_raw_data->>'application')
    END) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "cancellation_reason" text GENERATED ALWAYS AS ((_raw_data->>'cancellation_reason')::text) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "client_secret" text GENERATED ALWAYS AS ((_raw_data->>'client_secret')::text) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "description" text GENERATED ALWAYS AS ((_raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "last_setup_error" jsonb GENERATED ALWAYS AS ((_raw_data->'last_setup_error')::jsonb) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "mandate" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'mandate') = 'object' AND _raw_data->'mandate' ? 'id'
        THEN (_raw_data->'mandate'->>'id')
      ELSE (_raw_data->>'mandate')
    END) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "next_action" jsonb GENERATED ALWAYS AS ((_raw_data->'next_action')::jsonb) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "on_behalf_of" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'on_behalf_of') = 'object' AND _raw_data->'on_behalf_of' ? 'id'
        THEN (_raw_data->'on_behalf_of'->>'id')
      ELSE (_raw_data->>'on_behalf_of')
    END) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'payment_method') = 'object' AND _raw_data->'payment_method' ? 'id'
        THEN (_raw_data->'payment_method'->>'id')
      ELSE (_raw_data->>'payment_method')
    END) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "payment_method_options" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_options')::jsonb) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "payment_method_types" jsonb GENERATED ALWAYS AS ((_raw_data->'payment_method_types')::jsonb) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "single_use_mandate" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'single_use_mandate') = 'object' AND _raw_data->'single_use_mandate' ? 'id'
        THEN (_raw_data->'single_use_mandate'->>'id')
      ELSE (_raw_data->>'single_use_mandate')
    END) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "usage" text GENERATED ALWAYS AS ((_raw_data->>'usage')::text) STORED;

ALTER TABLE "stripe"."setup_intents" ADD CONSTRAINT "fk_setup_intents_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_setup_intents_account_id" ON "stripe"."setup_intents" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."setup_intents";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."setup_intents" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."subscription_items" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "billing_thresholds" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_thresholds')::jsonb) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "deleted" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'deleted', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "price" jsonb GENERATED ALWAYS AS ((_raw_data->'price')::jsonb) STORED,
  "quantity" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity', ''))::bigint) STORED,
  "subscription" text GENERATED ALWAYS AS ((_raw_data->>'subscription')::text) STORED,
  "tax_rates" jsonb GENERATED ALWAYS AS ((_raw_data->'tax_rates')::jsonb) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "billing_thresholds" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_thresholds')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "deleted" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'deleted', ''))::boolean) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "price" jsonb GENERATED ALWAYS AS ((_raw_data->'price')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "quantity" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "subscription" text GENERATED ALWAYS AS ((_raw_data->>'subscription')::text) STORED;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "tax_rates" jsonb GENERATED ALWAYS AS ((_raw_data->'tax_rates')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_items" ADD CONSTRAINT "fk_subscription_items_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_subscription_items_account_id" ON "stripe"."subscription_items" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."subscription_items";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."subscription_items" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."subscription_schedules" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "canceled_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'canceled_at', ''))::bigint) STORED,
  "completed_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'completed_at', ''))::bigint) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "current_phase" jsonb GENERATED ALWAYS AS ((_raw_data->'current_phase')::jsonb) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "default_settings" jsonb GENERATED ALWAYS AS ((_raw_data->'default_settings')::jsonb) STORED,
  "end_behavior" text GENERATED ALWAYS AS ((_raw_data->>'end_behavior')::text) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "phases" jsonb GENERATED ALWAYS AS ((_raw_data->'phases')::jsonb) STORED,
  "released_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'released_at', ''))::bigint) STORED,
  "released_subscription" text GENERATED ALWAYS AS ((_raw_data->>'released_subscription')::text) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "subscription" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'subscription') = 'object' AND _raw_data->'subscription' ? 'id'
        THEN (_raw_data->'subscription'->>'id')
      ELSE (_raw_data->>'subscription')
    END) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "canceled_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'canceled_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "completed_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'completed_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "current_phase" jsonb GENERATED ALWAYS AS ((_raw_data->'current_phase')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "default_settings" jsonb GENERATED ALWAYS AS ((_raw_data->'default_settings')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "end_behavior" text GENERATED ALWAYS AS ((_raw_data->>'end_behavior')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "phases" jsonb GENERATED ALWAYS AS ((_raw_data->'phases')::jsonb) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "released_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'released_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "released_subscription" text GENERATED ALWAYS AS ((_raw_data->>'released_subscription')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "subscription" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'subscription') = 'object' AND _raw_data->'subscription' ? 'id'
        THEN (_raw_data->'subscription'->>'id')
      ELSE (_raw_data->>'subscription')
    END) STORED;

ALTER TABLE "stripe"."subscription_schedules" ADD CONSTRAINT "fk_subscription_schedules_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_subscription_schedules_account_id" ON "stripe"."subscription_schedules" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."subscription_schedules";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."subscription_schedules" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."subscriptions" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "application_fee_percent" numeric GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_percent', ''))::numeric) STORED,
  "billing_cycle_anchor" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'billing_cycle_anchor', ''))::bigint) STORED,
  "billing_thresholds" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_thresholds')::jsonb) STORED,
  "cancel_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'cancel_at', ''))::bigint) STORED,
  "cancel_at_period_end" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'cancel_at_period_end', ''))::boolean) STORED,
  "canceled_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'canceled_at', ''))::bigint) STORED,
  "collection_method" text GENERATED ALWAYS AS ((_raw_data->>'collection_method')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "current_period_end" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'current_period_end', ''))::bigint) STORED,
  "current_period_start" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'current_period_start', ''))::bigint) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "days_until_due" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'days_until_due', ''))::bigint) STORED,
  "default_payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_payment_method') = 'object' AND _raw_data->'default_payment_method' ? 'id'
        THEN (_raw_data->'default_payment_method'->>'id')
      ELSE (_raw_data->>'default_payment_method')
    END) STORED,
  "default_source" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_source') = 'object' AND _raw_data->'default_source' ? 'id'
        THEN (_raw_data->'default_source'->>'id')
      ELSE (_raw_data->>'default_source')
    END) STORED,
  "default_tax_rates" jsonb GENERATED ALWAYS AS ((_raw_data->'default_tax_rates')::jsonb) STORED,
  "discount" jsonb GENERATED ALWAYS AS ((_raw_data->'discount')::jsonb) STORED,
  "ended_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'ended_at', ''))::bigint) STORED,
  "items" jsonb GENERATED ALWAYS AS ((_raw_data->'items')::jsonb) STORED,
  "latest_invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'latest_invoice') = 'object' AND _raw_data->'latest_invoice' ? 'id'
        THEN (_raw_data->'latest_invoice'->>'id')
      ELSE (_raw_data->>'latest_invoice')
    END) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED,
  "next_pending_invoice_item_invoice" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'next_pending_invoice_item_invoice', ''))::bigint) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "pause_collection" jsonb GENERATED ALWAYS AS ((_raw_data->'pause_collection')::jsonb) STORED,
  "pending_invoice_item_interval" jsonb GENERATED ALWAYS AS ((_raw_data->'pending_invoice_item_interval')::jsonb) STORED,
  "pending_setup_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'pending_setup_intent') = 'object' AND _raw_data->'pending_setup_intent' ? 'id'
        THEN (_raw_data->'pending_setup_intent'->>'id')
      ELSE (_raw_data->>'pending_setup_intent')
    END) STORED,
  "pending_update" jsonb GENERATED ALWAYS AS ((_raw_data->'pending_update')::jsonb) STORED,
  "quantity" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity', ''))::bigint) STORED,
  "schedule" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'schedule') = 'object' AND _raw_data->'schedule' ? 'id'
        THEN (_raw_data->'schedule'->>'id')
      ELSE (_raw_data->>'schedule')
    END) STORED,
  "start_date" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'start_date', ''))::bigint) STORED,
  "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED,
  "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED,
  "trial_end" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'trial_end', ''))::bigint) STORED,
  "trial_start" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'trial_start', ''))::bigint) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "application_fee_percent" numeric GENERATED ALWAYS AS ((NULLIF(_raw_data->>'application_fee_percent', ''))::numeric) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "billing_cycle_anchor" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'billing_cycle_anchor', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "billing_thresholds" jsonb GENERATED ALWAYS AS ((_raw_data->'billing_thresholds')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "cancel_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'cancel_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'cancel_at_period_end', ''))::boolean) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "canceled_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'canceled_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "collection_method" text GENERATED ALWAYS AS ((_raw_data->>'collection_method')::text) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "current_period_end" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'current_period_end', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "current_period_start" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'current_period_start', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "days_until_due" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'days_until_due', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "default_payment_method" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_payment_method') = 'object' AND _raw_data->'default_payment_method' ? 'id'
        THEN (_raw_data->'default_payment_method'->>'id')
      ELSE (_raw_data->>'default_payment_method')
    END) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "default_source" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'default_source') = 'object' AND _raw_data->'default_source' ? 'id'
        THEN (_raw_data->'default_source'->>'id')
      ELSE (_raw_data->>'default_source')
    END) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "default_tax_rates" jsonb GENERATED ALWAYS AS ((_raw_data->'default_tax_rates')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "discount" jsonb GENERATED ALWAYS AS ((_raw_data->'discount')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "ended_at" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'ended_at', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "items" jsonb GENERATED ALWAYS AS ((_raw_data->'items')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "latest_invoice" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'latest_invoice') = 'object' AND _raw_data->'latest_invoice' ? 'id'
        THEN (_raw_data->'latest_invoice'->>'id')
      ELSE (_raw_data->>'latest_invoice')
    END) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "metadata" jsonb GENERATED ALWAYS AS ((_raw_data->'metadata')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "next_pending_invoice_item_invoice" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'next_pending_invoice_item_invoice', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "pause_collection" jsonb GENERATED ALWAYS AS ((_raw_data->'pause_collection')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "pending_invoice_item_interval" jsonb GENERATED ALWAYS AS ((_raw_data->'pending_invoice_item_interval')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "pending_setup_intent" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'pending_setup_intent') = 'object' AND _raw_data->'pending_setup_intent' ? 'id'
        THEN (_raw_data->'pending_setup_intent'->>'id')
      ELSE (_raw_data->>'pending_setup_intent')
    END) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "pending_update" jsonb GENERATED ALWAYS AS ((_raw_data->'pending_update')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "quantity" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "schedule" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'schedule') = 'object' AND _raw_data->'schedule' ? 'id'
        THEN (_raw_data->'schedule'->>'id')
      ELSE (_raw_data->>'schedule')
    END) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "start_date" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'start_date', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "status" text GENERATED ALWAYS AS ((_raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "transfer_data" jsonb GENERATED ALWAYS AS ((_raw_data->'transfer_data')::jsonb) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "trial_end" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'trial_end', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "trial_start" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'trial_start', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscriptions" ADD CONSTRAINT "fk_subscriptions_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_subscriptions_account_id" ON "stripe"."subscriptions" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."subscriptions";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."subscriptions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "stripe"."tax_ids" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz NOT NULL DEFAULT now(),
  "_account_id" text NOT NULL,
  "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
  "country" text GENERATED ALWAYS AS ((_raw_data->>'country')::text) STORED,
  "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
  "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED,
  "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED,
  "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED,
  "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED,
  "value" text GENERATED ALWAYS AS ((_raw_data->>'value')::text) STORED,
  "verification" jsonb GENERATED ALWAYS AS ((_raw_data->'verification')::jsonb) STORED,
  PRIMARY KEY ("id")
);

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "country" text GENERATED ALWAYS AS ((_raw_data->>'country')::text) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "created" bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "customer" text GENERATED ALWAYS AS (CASE
      WHEN jsonb_typeof(_raw_data->'customer') = 'object' AND _raw_data->'customer' ? 'id'
        THEN (_raw_data->'customer'->>'id')
      ELSE (_raw_data->>'customer')
    END) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "livemode" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'livemode', ''))::boolean) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "object" text GENERATED ALWAYS AS ((_raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "type" text GENERATED ALWAYS AS ((_raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "value" text GENERATED ALWAYS AS ((_raw_data->>'value')::text) STORED;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "verification" jsonb GENERATED ALWAYS AS ((_raw_data->'verification')::jsonb) STORED;

ALTER TABLE "stripe"."tax_ids" ADD CONSTRAINT "fk_tax_ids_account" FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

CREATE INDEX "idx_tax_ids_account_id" ON "stripe"."tax_ids" ("_account_id");

DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."tax_ids";

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON "stripe"."tax_ids" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
