# Schema Management Guide

This guide covers how to manage database schemas generated from OpenAPI specifications, including indexing strategies, performance optimization, and schema evolution.

## Overview

The OpenAPI-based sync engine generates PostgreSQL schemas dynamically, creating tables with columns optimized for indexing and query performance. Understanding how to manage these schemas is crucial for production deployments.

## Generated Schema Structure

### Table Naming Convention

Tables are named using pluralized object names:
- `customer` → `stripe.customers`
- `payment_intent` → `stripe.payment_intents`
- `subscription_item` → `stripe.subscription_items`

### Column Type Mapping

The sync engine maps OpenAPI types to PostgreSQL types optimized for performance:

| OpenAPI Type | PostgreSQL Type | Indexable | Notes |
|-------------|----------------|-----------|--------|
| `string` | `text` | ✓ B-tree | Standard text fields |
| `integer` | `bigint` | ✓ B-tree | Safe for large amounts |
| `integer` (unix-time) | `bigint` | ✓ B-tree | Timestamp fields |
| `number` | `numeric` | ✓ B-tree | Decimal precision |
| `boolean` | `boolean` | ✓ B-tree | True/false values |
| `object` | `jsonb` | ✓ GIN | Complex nested data |
| `array` (strings) | `text[]` | ✓ GIN | Simple string arrays |
| `array` (objects) | `jsonb` | ✓ GIN | Complex object arrays |
| `anyOf/oneOf/$ref` | `jsonb` | ✓ GIN | Union types |

### Special Fields

Certain fields receive special treatment:

```sql
-- Always present in Stripe objects
"id" text PRIMARY KEY,           -- Stripe object ID
"object" text,                   -- Stripe object type
"created" bigint,               -- Unix timestamp
"livemode" boolean,             -- Test vs live mode

-- Common fields
"metadata" jsonb,               -- User-defined key-value pairs
"updated" bigint                -- Last update timestamp (when available)
```

## Indexing Strategies

### Automatic Primary Key

Every table gets a primary key on the `id` field:

```sql
CREATE TABLE "stripe"."customers" (
  "id" text PRIMARY KEY,
  -- other columns...
);
```

### Recommended Indexes

After table creation, add indexes based on your query patterns:

#### Common Query Patterns

```sql
-- Customer lookups by email
CREATE INDEX idx_customers_email ON stripe.customers(email);

-- Time-based queries
CREATE INDEX idx_customers_created ON stripe.customers(created);
CREATE INDEX idx_payment_intents_created ON stripe.payment_intents(created);

-- Status filtering
CREATE INDEX idx_subscriptions_status ON stripe.subscriptions(status);
CREATE INDEX idx_payment_intents_status ON stripe.payment_intents(status);

-- Foreign key relationships
CREATE INDEX idx_charges_customer ON stripe.charges(customer);
CREATE INDEX idx_subscriptions_customer ON stripe.subscriptions(customer);
CREATE INDEX idx_payment_intents_customer ON stripe.payment_intents(customer);
```

#### JSONB Indexes (GIN)

For complex fields stored as JSONB:

```sql
-- Metadata searches
CREATE INDEX idx_customers_metadata ON stripe.customers USING GIN (metadata);
CREATE INDEX idx_payment_intents_metadata ON stripe.payment_intents USING GIN (metadata);

-- Specific metadata keys (more efficient for known keys)
CREATE INDEX idx_customers_metadata_user_id ON stripe.customers USING GIN ((metadata->'user_id'));

-- Array fields
CREATE INDEX idx_payment_intents_payment_method_types
ON stripe.payment_intents USING GIN (payment_method_types);

-- Complex nested objects
CREATE INDEX idx_charges_outcome ON stripe.charges USING GIN (outcome);
CREATE INDEX idx_payment_intents_next_action ON stripe.payment_intents USING GIN (next_action);
```

#### Composite Indexes

For multi-column queries:

```sql
-- Customer + time range queries
CREATE INDEX idx_payment_intents_customer_created
ON stripe.payment_intents(customer, created);

-- Status + time queries
CREATE INDEX idx_subscriptions_status_created
ON stripe.subscriptions(status, created);

-- Amount range queries with customer
CREATE INDEX idx_charges_customer_amount
ON stripe.charges(customer, amount);
```

## Schema Evolution

### How Evolution Works

When you update your OpenAPI spec, the sync engine can safely add new columns:

1. **Analyze differences** between current schema and new spec
2. **Generate ALTER TABLE statements** for new columns
3. **Add columns as nullable** (safe for existing data)
4. **Log all changes** with timestamps

### Evolution Commands

```bash
# See what changes would be made
sync-engine diff-schema --spec=/path/to/new-spec.json --existing-db=$DATABASE_URL

# Generate evolution SQL statements
sync-engine generate-evolution --objects=customer,payment_intent --spec=/path/to/new-spec.json --existing-db=$DATABASE_URL

# Apply changes
sync-engine migrate --spec=/path/to/new-spec.json --objects=customer,payment_intent
```

### Example Evolution

Original table:
```sql
CREATE TABLE "stripe"."customers" (
  "id" text PRIMARY KEY,
  "email" text,
  "name" text,
  "created" bigint
);
```

After OpenAPI spec update:
```sql
-- New columns added automatically
ALTER TABLE "stripe"."customers" ADD COLUMN "phone" text;
ALTER TABLE "stripe"."customers" ADD COLUMN "preferred_locales" text[];
ALTER TABLE "stripe"."customers" ADD COLUMN "tax_exempt" text;
```

### Evolution Best Practices

1. **Test in development first**
   ```bash
   # Use a copy of your production data
   sync-engine generate-evolution --objects=customer --spec=/path/to/new-spec.json --existing-db=$DEV_DATABASE_URL
   ```

2. **Review changes before applying**
   ```bash
   # Always check what will change
   sync-engine diff-schema --spec=/path/to/new-spec.json --existing-db=$DATABASE_URL
   ```

3. **Backup before major changes**
   ```bash
   pg_dump $DATABASE_URL > backup_before_evolution.sql
   ```

4. **Monitor for performance impact**
   - Adding columns is generally safe
   - Consider index implications for new columns
   - Monitor query performance after changes

## Performance Optimization

### Query Optimization

#### Use Appropriate Indexes

```sql
-- For exact matches
CREATE INDEX idx_customers_email ON stripe.customers(email);
SELECT * FROM stripe.customers WHERE email = 'user@example.com';

-- For range queries
CREATE INDEX idx_payment_intents_created ON stripe.payment_intents(created);
SELECT * FROM stripe.payment_intents WHERE created > 1640995200;

-- For JSONB containment
CREATE INDEX idx_customers_metadata ON stripe.customers USING GIN (metadata);
SELECT * FROM stripe.customers WHERE metadata @> '{"plan": "premium"}';
```

#### JSONB Query Patterns

```sql
-- Existence checks (fast with GIN index)
SELECT * FROM stripe.customers WHERE metadata ? 'user_id';

-- Value matching
SELECT * FROM stripe.customers WHERE metadata->>'plan' = 'premium';

-- Containment (very efficient with GIN)
SELECT * FROM stripe.customers WHERE metadata @> '{"active": true}';

-- Array containment
SELECT * FROM stripe.payment_intents WHERE payment_method_types @> ARRAY['card'];
```

### Storage Optimization

#### Table Partitioning

For high-volume tables, consider partitioning by time:

```sql
-- Partition charges by month
CREATE TABLE stripe.charges (
  LIKE stripe.charges_template INCLUDING ALL
) PARTITION BY RANGE (created);

-- Create monthly partitions
CREATE TABLE stripe.charges_2024_01 PARTITION OF stripe.charges
FOR VALUES FROM (1704067200) TO (1706745600);

CREATE TABLE stripe.charges_2024_02 PARTITION OF stripe.charges
FOR VALUES FROM (1706745600) TO (1709251200);
```

#### Archive Old Data

```sql
-- Archive old charges (example: older than 2 years)
CREATE TABLE stripe.charges_archive AS
SELECT * FROM stripe.charges
WHERE created < extract(epoch from now() - interval '2 years');

DELETE FROM stripe.charges
WHERE created < extract(epoch from now() - interval '2 years');
```

### Memory and Connection Management

#### Connection Pooling

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // Maximum connections
  idleTimeoutMillis: 30000,   // Close idle connections
  connectionTimeoutMillis: 2000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
```

#### Query Optimization

```typescript
// Use prepared statements for repeated queries
const getCustomerPayments = await pool.query({
  name: 'get-customer-payments',
  text: 'SELECT * FROM stripe.payment_intents WHERE customer = $1 ORDER BY created DESC LIMIT $2',
  values: [customerId, limit]
});

// Use streaming for large result sets
const { Readable } = require('stream');
const stream = pool.query(new Cursor('SELECT * FROM stripe.charges WHERE created > $1', [timestamp]));
```

## Monitoring and Maintenance

### Schema Information Queries

```sql
-- List all Stripe tables
SELECT schemaname, tablename, tableowner
FROM pg_tables
WHERE schemaname = 'stripe'
ORDER BY tablename;

-- Get table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE schemaname = 'stripe'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check index usage
SELECT
  schemaname,
  tablename,
  indexname,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'stripe'
ORDER BY idx_tup_read DESC;
```

### Performance Monitoring

```sql
-- Slow query identification
SELECT
  query,
  calls,
  total_time,
  mean_time,
  rows
FROM pg_stat_statements
WHERE query LIKE '%stripe.%'
ORDER BY mean_time DESC
LIMIT 10;

-- Table statistics
SELECT
  schemaname,
  tablename,
  n_tup_ins,
  n_tup_upd,
  n_tup_del,
  n_live_tup,
  n_dead_tup
FROM pg_stat_user_tables
WHERE schemaname = 'stripe';
```

### Maintenance Tasks

#### Regular Maintenance

```sql
-- Update table statistics
ANALYZE stripe.customers;
ANALYZE stripe.payment_intents;
ANALYZE stripe.charges;

-- Vacuum tables (reclaim space)
VACUUM stripe.charges;

-- Full vacuum with reindex (during maintenance windows)
VACUUM FULL stripe.charges;
REINDEX TABLE stripe.charges;
```

#### Automated Maintenance

```sql
-- Set up automatic vacuum and analyze
ALTER TABLE stripe.customers SET (
  autovacuum_vacuum_scale_factor = 0.1,
  autovacuum_analyze_scale_factor = 0.05
);
```

## Backup and Recovery

### Backup Strategies

```bash
# Full database backup
pg_dump $DATABASE_URL > stripe_sync_backup_$(date +%Y%m%d).sql

# Schema-only backup
pg_dump --schema-only --schema=stripe $DATABASE_URL > stripe_schema_backup.sql

# Data-only backup
pg_dump --data-only --schema=stripe $DATABASE_URL > stripe_data_backup.sql

# Compressed backup
pg_dump $DATABASE_URL | gzip > stripe_sync_backup_$(date +%Y%m%d).sql.gz
```

### Recovery Procedures

```bash
# Restore full backup
psql $DATABASE_URL < stripe_sync_backup_20240101.sql

# Restore to new database
createdb stripe_sync_restored
psql stripe_sync_restored < stripe_sync_backup_20240101.sql

# Restore specific schema
psql $DATABASE_URL < stripe_schema_backup.sql
```

### Point-in-Time Recovery

```bash
# Create base backup
pg_basebackup -D /backup/base -Ft -z -P -h localhost -U postgres

# Restore to specific time
pg_ctl start -D /backup/restored
# Edit recovery.conf with restore_command and recovery_target_time
```

## Troubleshooting

### Common Issues

#### Index Bloat

```sql
-- Check index bloat
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
  round((100 * (pg_relation_size(indexrelid) - pg_relation_size(indexrelid, 'main'))) / pg_relation_size(indexrelid)) as bloat_ratio
FROM pg_stat_user_indexes
WHERE schemaname = 'stripe'
  AND pg_relation_size(indexrelid) > 1000000
ORDER BY bloat_ratio DESC;

-- Fix bloat with reindex
REINDEX INDEX idx_customers_email;
```

#### Table Bloat

```sql
-- Check table bloat
SELECT
  schemaname,
  tablename,
  n_dead_tup,
  n_live_tup,
  round((n_dead_tup::float / (n_live_tup + n_dead_tup + 1)::float) * 100, 2) as bloat_ratio
FROM pg_stat_user_tables
WHERE schemaname = 'stripe'
  AND n_live_tup > 0
ORDER BY bloat_ratio DESC;

-- Fix with vacuum
VACUUM FULL stripe.customers;
```

#### Slow Queries

```sql
-- Enable query logging
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- Log queries > 1 second
SELECT pg_reload_conf();

-- Analyze slow queries
EXPLAIN ANALYZE SELECT * FROM stripe.customers WHERE email = 'user@example.com';
```

### Performance Tuning

#### PostgreSQL Configuration

```ini
# postgresql.conf optimizations for Stripe data
shared_buffers = 256MB                    # 25% of RAM
effective_cache_size = 1GB               # 75% of RAM
random_page_cost = 1.1                   # For SSD storage
work_mem = 16MB                          # Per query memory
maintenance_work_mem = 256MB             # For maintenance operations
checkpoint_completion_target = 0.9       # Smooth checkpoints
wal_buffers = 16MB                       # WAL buffer size
```

#### Connection Pooling

Use PgBouncer for connection pooling:

```ini
# pgbouncer.ini
[databases]
stripe_sync = host=localhost port=5432 dbname=stripe_sync

[pgbouncer]
pool_mode = transaction
max_client_conn = 100
default_pool_size = 20
```

## Best Practices Summary

1. **Index Strategy**
   - Create indexes based on actual query patterns
   - Use GIN indexes for JSONB and array columns
   - Monitor index usage and remove unused indexes

2. **Schema Evolution**
   - Always test in development first
   - Use diff commands to preview changes
   - Backup before major schema updates

3. **Performance**
   - Monitor query performance regularly
   - Use appropriate data types from OpenAPI mapping
   - Consider partitioning for high-volume tables

4. **Maintenance**
   - Set up automated vacuum and analyze
   - Monitor table and index bloat
   - Regular backups and recovery testing

5. **Monitoring**
   - Use pg_stat_statements for query analysis
   - Monitor connection pool usage
   - Track table growth and storage usage

## Related Documentation

- [API Version Management](api-versions.md)
- [Adding New Stripe Objects](adding-objects.md)
- [Architecture Documentation](architecture/openapi.md)
- [CLI Reference](cli-reference.md)