# Adding New Stripe Objects Guide

This guide explains how to add new Stripe objects to your sync configuration using the OpenAPI-based approach.

## Overview

With the OpenAPI-based sync engine, adding new Stripe objects is straightforward:

1. **Verify the object exists in your OpenAPI spec**
2. **Add it to your configuration**
3. **Run migrations to create the table**
4. **Configure your sync process**

All table structures are dynamically generated from the OpenAPI specification - no manual schema definition required.

## Step-by-Step Process

### 1. Check Available Objects

First, see what objects are available in your OpenAPI spec:

```bash
# List all objects in the spec
sync-engine list-objects --spec=/pay/src/openapi/latest/openapi.spec3.json

# Get details about a specific object
sync-engine describe-object --object=payment_intent --spec=/pay/src/openapi/latest/openapi.spec3.json
```

Example output:
```
Available Stripe Objects:
- customer
- charge
- payment_intent
- subscription
- invoice
- product
- price
- setup_intent
- payment_method
- dispute
- refund
- ... (and more)
```

### 2. Update Your Configuration

Add the new object to your sync configuration:

```typescript
// Before - syncing customers and charges
const config = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: ['customer', 'charge'],
  databaseUrl: process.env.DATABASE_URL
};

// After - adding payment_intent and subscription
const config = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: ['customer', 'charge', 'payment_intent', 'subscription'],
  databaseUrl: process.env.DATABASE_URL
};
```

### 3. Generate Schema for New Objects

Run migrations to create tables for the new objects:

```bash
# Preview what will be created
sync-engine generate-schema --objects=payment_intent,subscription --spec=/pay/src/openapi/latest/openapi.spec3.json

# Create the tables
sync-engine migrate --spec=/pay/src/openapi/latest/openapi.spec3.json --objects=payment_intent,subscription

# Or migrate all configured objects at once
sync-engine migrate --spec=/pay/src/openapi/latest/openapi.spec3.json --objects=customer,charge,payment_intent,subscription
```

### 4. Verify Table Creation

Check that the new tables were created correctly:

```sql
-- Connect to your database and verify tables exist
\dt stripe.*

-- Check the structure of a new table
\d stripe.payment_intents

-- Verify columns match the OpenAPI spec
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'payment_intents'
  AND table_schema = 'stripe'
ORDER BY ordinal_position;
```

### 5. Start Syncing Data

The new objects will automatically be included in your sync process:

```typescript
import { StripeSync } from 'stripe-experiment-sync';

const sync = new StripeSync({
  poolConfig: {
    connectionString: process.env.DATABASE_URL,
  },
  stripeSecretKey: process.env.STRIPE_API_KEY,
});

// Create webhook that will sync all configured objects
const webhook = await sync.findOrCreateManagedWebhook('https://your-app.com/webhook');

// Optionally backfill historical data for new objects
await sync.backfill('payment_intent');
await sync.backfill('subscription');
```

## Common Use Cases

### Adding Core Payment Objects

For a complete payment processing setup:

```typescript
const paymentConfig = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: [
    'customer',
    'payment_intent',
    'payment_method',
    'charge',
    'refund'
  ],
  databaseUrl: process.env.DATABASE_URL
};
```

### Adding Subscription Management

For subscription businesses:

```typescript
const subscriptionConfig = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: [
    'customer',
    'product',
    'price',
    'subscription',
    'subscription_item',
    'invoice',
    'invoice_item'
  ],
  databaseUrl: process.env.DATABASE_URL
};
```

### Adding Dispute Management

For handling disputes and chargebacks:

```typescript
const disputeConfig = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: [
    'charge',
    'dispute',
    'early_fraud_warning'
  ],
  databaseUrl: process.env.DATABASE_URL
};
```

## CLI Commands for Object Management

### List Available Objects

```bash
# See all objects available in the OpenAPI spec
sync-engine list-objects --spec=/pay/src/openapi/latest/openapi.spec3.json

# Filter objects by pattern
sync-engine list-objects --spec=/pay/src/openapi/latest/openapi.spec3.json --filter=payment
```

### Describe Object Schema

```bash
# Get detailed information about an object
sync-engine describe-object --object=payment_intent --spec=/pay/src/openapi/latest/openapi.spec3.json

# See what table structure would be generated
sync-engine generate-schema --objects=payment_intent --spec=/pay/src/openapi/latest/openapi.spec3.json
```

### Validate Object Configuration

```bash
# Ensure your objects exist in the spec
sync-engine validate-schemas --objects=customer,payment_intent,subscription --spec=/pay/src/openapi/latest/openapi.spec3.json

# Check for any issues with your configuration
sync-engine validate-schemas --config=/path/to/your/config.json --spec=/pay/src/openapi/latest/openapi.spec3.json
```

## Table Structure Generation

### Automatic Table Naming

Objects are converted to table names using these rules:

- `customer` → `customers`
- `payment_intent` → `payment_intents`
- `charge` → `charges`
- `subscription_item` → `subscription_items`

### Column Generation

All columns are generated from the OpenAPI spec:

```sql
-- Example: payment_intents table (generated automatically)
CREATE TABLE IF NOT EXISTS "stripe"."payment_intents" (
  "id" text PRIMARY KEY,
  "object" text,
  "amount" bigint,
  "amount_capturable" bigint,
  "amount_received" bigint,
  "application" text,
  "application_fee_amount" bigint,
  "automatic_payment_methods" jsonb,
  "canceled_at" bigint,
  "cancellation_reason" text,
  "capture_method" text,
  "charges" jsonb,
  "client_secret" text,
  "confirmation_method" text,
  "created" bigint,
  "currency" text,
  "customer" text,
  "description" text,
  "invoice" text,
  "last_payment_error" jsonb,
  "latest_charge" text,
  "livemode" boolean,
  "metadata" jsonb,
  "next_action" jsonb,
  "on_behalf_of" text,
  "payment_method" text,
  "payment_method_options" jsonb,
  "payment_method_types" text[],
  "processing" jsonb,
  "receipt_email" text,
  "review" text,
  "setup_future_usage" text,
  "shipping" jsonb,
  "statement_descriptor" text,
  "statement_descriptor_suffix" text,
  "status" text,
  "transfer_data" jsonb,
  "transfer_group" text
);
```

### Indexing Recommendations

After creating tables, consider adding indexes:

```sql
-- Common indexes for payment_intents
CREATE INDEX idx_payment_intents_customer ON stripe.payment_intents(customer);
CREATE INDEX idx_payment_intents_status ON stripe.payment_intents(status);
CREATE INDEX idx_payment_intents_created ON stripe.payment_intents(created);
CREATE INDEX idx_payment_intents_amount ON stripe.payment_intents(amount);

-- JSONB indexes for complex fields
CREATE INDEX idx_payment_intents_metadata ON stripe.payment_intents USING GIN (metadata);
CREATE INDEX idx_payment_intents_charges ON stripe.payment_intents USING GIN (charges);
```

## Troubleshooting

### Object Not Found

```bash
Error: Object "payment_intents" not found in OpenAPI spec
```

**Solution**: Use the correct object name (singular):

```bash
# Incorrect
sync-engine describe-object --object=payment_intents

# Correct
sync-engine describe-object --object=payment_intent
```

Check available objects:
```bash
sync-engine list-objects --spec=/pay/src/openapi/latest/openapi.spec3.json
```

### Table Already Exists

```bash
Error: Table "payment_intents" already exists
```

**Solution**: The sync engine uses `CREATE TABLE IF NOT EXISTS`, so this shouldn't occur. If it does:

1. Check if you're using the correct schema name
2. Verify table permissions
3. Use `--dry-run` to see what would be created

### Missing Columns After Update

**Issue**: New properties in the OpenAPI spec don't appear in existing tables

**Solution**: Run schema evolution:

```bash
# See what columns would be added
sync-engine generate-evolution --objects=payment_intent --spec=/pay/src/openapi/latest/openapi.spec3.json --existing-db=$DATABASE_URL

# Apply the changes
sync-engine migrate --spec=/pay/src/openapi/latest/openapi.spec3.json --objects=payment_intent
```

### Performance Issues with Large Objects

**Issue**: Some Stripe objects (like `charge`) have many properties and create wide tables

**Solution**:

1. Use property whitelisting (when implemented)
2. Add selective indexes
3. Consider object-specific schemas

```typescript
// Future: Property whitelisting
const config = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: [{
    name: 'charge',
    properties: ['id', 'amount', 'currency', 'customer', 'created', 'status']
  }],
  databaseUrl: process.env.DATABASE_URL
};
```

## Best Practices

### 1. Start with Core Objects

Begin with essential objects for your use case:

```typescript
// Minimal payment setup
const coreObjects = ['customer', 'payment_intent', 'charge'];

// Add more as needed
const expandedObjects = ['customer', 'payment_intent', 'charge', 'refund', 'dispute'];
```

### 2. Group Related Objects

Add objects in logical groups:

```typescript
// Payment processing group
const paymentObjects = ['customer', 'payment_intent', 'payment_method', 'charge'];

// Subscription group
const subscriptionObjects = ['product', 'price', 'subscription', 'invoice'];

// Combine as needed
const allObjects = [...paymentObjects, ...subscriptionObjects];
```

### 3. Test in Development First

Always test new objects in a development environment:

```bash
# Development database
export DEV_DATABASE_URL="postgresql://localhost/dev_stripe_sync"

# Test object addition
sync-engine migrate --spec=/pay/src/openapi/latest/openapi.spec3.json --objects=new_object

# Verify structure
sync-engine describe-object --object=new_object --spec=/pay/src/openapi/latest/openapi.spec3.json
```

### 4. Plan for Growth

Consider future objects when designing your schema:

- Use consistent schema naming
- Plan index strategy
- Consider table partitioning for high-volume objects

### 5. Monitor Performance

After adding objects:

- Monitor query performance
- Add indexes as needed
- Track database size growth
- Consider archiving strategies for historical data

## Integration with Application Code

### TypeScript Integration

Generate TypeScript types from your OpenAPI spec:

```typescript
// Future: Generated types
import type { PaymentIntent, Subscription } from './generated/stripe-types';

// Use in your application
const processPayment = (paymentIntent: PaymentIntent) => {
  // Type-safe access to all properties from OpenAPI spec
  console.log(paymentIntent.amount, paymentIntent.currency);
};
```

### Database Queries

Query your new objects:

```typescript
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Query payment intents
const getPaymentIntentsByCustomer = async (customerId: string) => {
  const result = await pool.query(
    'SELECT * FROM stripe.payment_intents WHERE customer = $1 ORDER BY created DESC',
    [customerId]
  );
  return result.rows;
};

// Query with JSONB fields
const getPaymentIntentsWithMetadata = async (key: string, value: string) => {
  const result = await pool.query(
    'SELECT * FROM stripe.payment_intents WHERE metadata->$1 = $2',
    [key, value]
  );
  return result.rows;
};
```

## Related Documentation

- [API Version Management](api-versions.md)
- [Schema Management](schema-management.md)
- [CLI Reference](cli-reference.md)
- [Architecture Documentation](architecture/openapi.md)