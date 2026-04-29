# Stripe Data Schema Projection Alignment Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the OpenAPI-to-Postgres projection with the Stripe Data schema rules: singular API-shaped tables, ID-only references, unconstrained enums, explicit deletion semantics, correct timestamp handling, list-envelope removal, reference indexes, and consistent sync metadata.

**Architecture:** Keep OpenAPI as the source of truth. Preserve projection metadata from `packages/openapi` through `packages/source-stripe` catalog generation, then make `packages/destination-postgres` consume that metadata mechanically when building DDL and writing records.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, PostgreSQL generated columns

---

## Requirements To Align

- Table names must be singular, snake_case, and derived from OpenAPI `x-resourceId`.
- Expandable references must be stored as Stripe IDs only, not embedded objects.
- Enums must project to unconstrained strings, not CHECK-constrained columns.
- Delete semantics must be finalized and represented consistently.
- V2 `date-time` fields should become native time columns.
- Stripe list envelopes must not remain inline on parent rows.
- Expandable references should get default join indexes.
- Sync metadata columns should use the agreed names and meanings.

---

## Task 1: Switch Resource Table Names To Singular

**Files:**

- Modify: `packages/openapi/specParser.ts`
- Modify: `packages/openapi/runtimeMappings.ts`
- Modify tests under `packages/openapi/__tests__/`
- Modify affected source/destination tests

**Steps:**

1. Change `resolveTableName()` so default names are singular snake_case:
   - `customer` -> `customer`
   - `payment_intent` -> `payment_intent`
   - `v2.core.account` -> `v2_core_account`
2. Revisit aliases in `OPENAPI_RESOURCE_TABLE_ALIASES`; remove plural aliases unless they document a real schema exception.
3. Update registry, catalog, event-routing, and tests that currently expect plural table names.
4. Decide whether existing deployed plural names need a migration/compatibility layer before changing runtime defaults.

**Verification:**

```bash
pnpm --filter @stripe/sync-openapi test
pnpm --filter @stripe/source-stripe test
pnpm --filter @stripe/destination-postgres test
```

---

## Task 2: Preserve Expandable Reference Metadata

**Files:**

- Modify: `packages/openapi/jsonSchemaConverter.ts`
- Modify: `packages/openapi/__tests__/jsonSchemaConverter.test.ts`
- Modify: `packages/destination-postgres/src/schemaProjection.ts`
- Modify: `packages/destination-postgres/src/schemaProjection.test.ts`

**Steps:**

1. Carry `ParsedColumn.expandableReference` into JSON Schema as `x-expandable-reference: true`.
2. Ensure nullable/composed schemas still retain this extension.
3. Confirm `jsonSchemaToColumns()` emits `text` generated columns that extract embedded object IDs when expanded objects arrive.
4. Add an end-to-end catalog conversion test for a field like `charge.customer`.

**Verification:**

```bash
pnpm --filter @stripe/sync-openapi test
pnpm --filter @stripe/destination-postgres test
```

---

## Task 3: Remove Enum CHECK Constraints From API Fields

**Files:**

- Modify: `packages/destination-postgres/src/schemaProjection.ts`
- Modify: `packages/destination-postgres/src/index.ts`
- Modify: `packages/destination-postgres/src/*.test.ts`
- Review: `packages/source-stripe/src/catalog.ts`

**Steps:**

1. Stop generating CHECK constraints for projected OpenAPI enum fields.
2. Decide whether `_account_id` allow-list enforcement remains a sync-system constraint or moves elsewhere.
3. If `_account_id` enforcement stays, make it explicit and separate from generic enum projection.
4. Remove or rewrite enum consistency checks that assume every enum maps to a database constraint.

**Verification:**

```bash
pnpm --filter @stripe/destination-postgres test
pnpm test
```

---

## Task 4: Finalize Delete Semantics

**Files:**

- Modify: `packages/source-stripe/src/process-event.ts`
- Modify: `packages/source-stripe/src/catalog.ts`
- Modify: `packages/destination-postgres/src/schemaProjection.ts`
- Modify: `packages/destination-postgres/src/index.ts`
- Modify related tests

**Steps:**

1. Resolve the product decision: physical deletes vs tombstone rows.
2. If tombstones win, add `_is_deleted` as a generated or written metadata column.
3. Map Stripe delete events to `_is_deleted = true` instead of only relying on raw `deleted: true`.
4. Review GDPR/redaction behavior for `_raw_data` retention before treating tombstones as final.

**Verification:**

```bash
pnpm --filter @stripe/source-stripe test
pnpm --filter @stripe/destination-postgres test
```

---

## Task 5: Fix V2 Timestamp Projection

**Files:**

- Modify: `packages/destination-postgres/src/schemaProjection.ts`
- Modify: `packages/openapi/jsonSchemaConverter.ts` if needed
- Modify timestamp tests

**Steps:**

1. Keep v1 Unix timestamp fields as `bigint`.
2. Project V2 `format: date-time` fields to `timestamptz` in Postgres.
3. Ensure generated column expressions cast valid ISO timestamp strings safely.
4. Avoid changing `_updated_at` legacy behavior unless a migration is included.

**Verification:**

```bash
pnpm --filter @stripe/destination-postgres test
```

---

## Task 6: Exclude List Envelopes From Parent Tables

**Files:**

- Modify: `packages/openapi/specParser.ts`
- Modify: `packages/openapi/__tests__/specParser.test.ts`
- Modify source tests around `subscription_items`

**Steps:**

1. Detect list-envelope fields shaped like Stripe list responses.
2. Exclude those fields from parent table columns.
3. Ensure child tables remain discoverable from nested list endpoints or resource schemas.
4. Document any resource-specific exceptions instead of hardcoding silent special cases.

**Verification:**

```bash
pnpm --filter @stripe/sync-openapi test
pnpm --filter @stripe/source-stripe test
```

---

## Task 7: Add Default Reference Indexes

**Files:**

- Modify: `packages/destination-postgres/src/schemaProjection.ts`
- Modify: `packages/destination-postgres/src/schemaProjection.test.ts`

**Steps:**

1. For every expandable reference column, create a default index.
2. For account-scoped tables, prefer composite indexes like `(_account_id, reference_column)`.
3. Keep index names deterministic and under Postgres identifier length limits.
4. Avoid physical foreign key constraints.

**Verification:**

```bash
pnpm --filter @stripe/destination-postgres test
```

---

## Task 8: Normalize Sync Metadata Naming

**Files:**

- Review: `packages/source-stripe/src/catalog.ts`
- Review: `packages/destination-postgres/src/schemaProjection.ts`
- Review: `packages/destination-postgres/src/index.ts`
- Review: state/storage migrations if metadata changes require persistence migration

**Steps:**

1. Decide whether the standard column is `_synced_at` or existing `_last_synced_at`.
2. Define the difference between source freshness (`_updated_at`) and sync write time.
3. Ensure metadata columns are clearly prefixed with `_` and never collide with OpenAPI fields.
4. Add migration guidance if renaming existing metadata columns.

**Verification:**

```bash
pnpm --filter @stripe/destination-postgres test
pnpm build
```

---

## Final Verification

```bash
pnpm format
pnpm lint
pnpm build
pnpm test
```

For integration confidence after the DDL changes:

```bash
pnpm test:integration
```

