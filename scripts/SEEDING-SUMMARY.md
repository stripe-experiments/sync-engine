# Schema Explorer Seeding Summary

## Overview

The `explorer-seed.ts` script has been successfully extended to implement a generic fallback seed generator for all projected tables in the Stripe schema. This ensures comprehensive coverage beyond the core 15 tables.

## Implementation Details

### Architecture

The seeding system now consists of three components:

1. **Graph-Aware Core Generators** (`StripeDataGraph` class)
   - Seeds 16 core tables with realistic, relationship-aware data
   - Maintains foreign key relationships (e.g., charges reference invoices and customers)
   - Uses stable, deterministic IDs (e.g., `cus_seed_001`, `in_seed_001`)

2. **Generic Fallback Generator** (`GenericTableSeeder` class)
   - Handles all remaining projected tables
   - Uses OpenAPI spec metadata to determine column types
   - Generates type-correct values for each column:
     - `text` columns: Stable strings based on column semantics
     - `bigint` columns: Deterministic integers (1-1,000,000)
     - `boolean` columns: Deterministic booleans
     - `timestamptz` columns: Unix timestamps within 2024
     - `numeric` columns: Decimal values
     - `json` columns: Stable JSON objects

3. **OpenAPI Spec Integration**
   - Uses `SpecParser` to discover all projected tables
   - Reads column metadata (name, type, nullable) from spec
   - Dynamically adapts to schema changes

### Seeding Process

1. **Phase 1: Core Tables**
   - Seeds 16 core tables with graph-aware data
   - Row counts: 1-45 rows per table (based on domain logic)
   - Total core rows: ~300 rows

2. **Phase 2: Discovery**
   - Resolves OpenAPI spec (v2020-08-27)
   - Parses all projected tables
   - Currently discovers 23 total tables

3. **Phase 3: Long-Tail Tables**
   - Seeds 8 long-tail tables with generic fallback
   - Row counts: 1-20 rows per table
   - Total long-tail rows: ~87 rows

4. **Phase 4: Verification**
   - Queries all tables for row counts
   - Generates manifest JSON with full statistics
   - Verifies all tables have at least 1 row

## Current Coverage

### Core Tables (16)
- `accounts` (1 row)
- `products` (8 rows)
- `prices` (12 rows)
- `customers` (25 rows)
- `payment_methods` (30 rows)
- `setup_intents` (15 rows)
- `subscriptions` (20 rows)
- `subscription_items` (30 rows)
- `invoices` (35 rows)
- `payment_intents` (40 rows)
- `charges` (45 rows)
- `refunds` (10 rows)
- `checkout_sessions` (18 rows)
- `credit_notes` (5 rows)
- `disputes` (3 rows)
- `tax_ids` (12 rows)

### Long-Tail Tables (8)
- `active_entitlements` (9 rows)
- `checkout_session_line_items` (10 rows)
- `coupons` (16 rows)
- `early_fraud_warnings` (2 rows)
- `features` (20 rows)
- `plans` (11 rows)
- `reviews` (5 rows)
- `subscription_schedules` (14 rows)

### Total Coverage
- **24 tables seeded**
- **~387 total rows**
- **100% table coverage** (all projected tables seeded)
- **0 failed tables**

## Determinism

The seeding system is fully deterministic:

- Uses fixed seed value (42)
- All random operations use `SeededRandom` class
- Re-running produces identical:
  - Row counts per table
  - Data values in each row
  - Column values (text, numbers, booleans, timestamps)

### Verification

```bash
# Run seeding twice and compare
npx tsx scripts/explorer-seed.ts
cat .tmp/seed-manifest.json | jq '.manifest'

npx tsx scripts/explorer-seed.ts
cat .tmp/seed-manifest.json | jq '.manifest'
# Results are identical
```

## Generated Columns

All Postgres generated columns work correctly:

- `text` columns extract string values from `_raw_data`
- `bigint` columns cast numeric values
- `boolean` columns cast boolean values
- `json` columns extract nested objects
- `timestamptz` stored as `text` (Postgres limitation on generated columns)

Example from `stripe.coupons`:
```sql
SELECT id, name, created, livemode, valid, amount_off
FROM stripe.coupons
LIMIT 3;

-- Results show properly typed values:
-- id: "coupons_seed_001"
-- name: "Generic name 1"
-- created: 1717841560 (bigint)
-- livemode: false (boolean)
-- valid: true (boolean)
-- amount_off: NULL or bigint
```

## Manifest Output

The script generates a comprehensive manifest at `.tmp/seed-manifest.json`:

```json
{
  "timestamp": "2026-03-11T08:01:01.740Z",
  "seed": 42,
  "apiVersion": "2020-08-27",
  "totalTables": 24,
  "coreTables": [...],
  "longTailTables": [...],
  "manifest": {
    "accounts": 1,
    "charges": 45,
    ...
  },
  "failedTables": [],
  "verification": {
    "allTablesSeeded": true,
    "tablesWithData": 24,
    "emptyTables": []
  }
}
```

## Acceptance Criteria Status

✅ **Every projected table has at least 1 row after seeding**
- All 24 projected tables contain data
- No tables are empty

✅ **Long-tail tables have 1-20 rows of type-correct data**
- Generic fallback generates 1-20 rows per table
- All column types are correctly handled (text, bigint, boolean, timestamptz, numeric, json)

✅ **Row-count manifest is printed and written**
- Console output displays full manifest
- JSON file written to `.tmp/seed-manifest.json`

✅ **Excluded tables are explicitly listed with reasons**
- Currently no excluded tables (all migrations succeeded)
- Failed tables would be listed in `failedTables` array with reasons

✅ **Fallback generator uses column metadata from SpecParser**
- `ParsedResourceTable` and `ParsedColumn` types used
- Column types from OpenAPI spec drive value generation

✅ **Re-running with same seed produces identical results**
- Verified through multiple runs
- Row counts, data values, and manifest are identical

## Future Enhancements

If more tables are discovered:

1. **Increase row count range**: Currently 1-20, could adjust based on table importance
2. **Add semantic type detection**: Better generation for specific column names (e.g., `email`, `phone`, `url`)
3. **Relationship inference**: Detect FK relationships in long-tail tables
4. **Configuration**: Make row counts and seed configurable via CLI args
5. **Lazy hydration**: If >100 tables, implement manifest-driven filtering

## Running the Seeder

```bash
# Ensure database is running
pnpm explorer:db:start

# Run migrations
pnpm explorer:db:migrate

# Run seeding
pnpm tsx scripts/explorer-seed.ts

# Check manifest
cat .tmp/seed-manifest.json

# Query seeded data
psql "$(cat .tmp/schema-explorer-run.json | jq -r .databaseUrl)" \
  -c "SELECT COUNT(*) FROM stripe.customers;"
```
