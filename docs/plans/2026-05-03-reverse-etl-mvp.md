# Reverse ETL MVP

## Background

Today sync engine mostly moves Stripe data out:

```
Stripe -> source-stripe -> sync engine -> destination-postgres
```

The inverse user problem is starting to show up too.

A team already has customer data in Postgres, a warehouse, or a CRM-owned database. They want that data reflected back in Stripe. Example:

```
crm.customers -> source-postgres -> sync engine -> destination-stripe -> Stripe Customers
```

This is the Hightouch-shaped workflow. Not the full product. The MVP version.

I want to take rows from a source table, map fields onto a Stripe object, and apply those changes safely. For the first pass, that probably means Customer upserts.

## Proposal

Build reverse ETL as normal connector composition.

Do not add a new engine mode yet. The current source/destination abstraction is already close:

- A source emits records and checkpoint messages.
- A destination consumes records and writes to some external system.
- The engine wires the two together.
- The destination decides when it is safe to re-emit `source_state`, which is effectively the checkpoint fence.

That last point matters. For Stripe writes, we only want to advance the Postgres cursor after the relevant Stripe mutations have succeeded.

The first concrete shape:

```
source-postgres
  reads crm.customers incrementally
  emits records keyed by crm_customer_id

sync engine
  pipes records and source_state through the normal pipeline

destination-stripe
  maps crm customer fields to Stripe Customer params
  updates an existing Customer or creates one when allowed
  re-emits source_state after Stripe writes are committed
```

## Goals

- Prove that reverse ETL fits the connector model without changing the core engine.
- Add a narrow `source-postgres` connector that can read one table or query incrementally.
- Add a narrow `destination-stripe` connector that can upsert Stripe Customers.
- Make identity and write safety explicit. No fuzzy matching by default.
- Keep the first version config-driven and developer-facing.

## Non-goals

- Not a full Hightouch replacement.
- No UI builder.
- No generic transformation DSL.
- No deletes or destructive Stripe actions.
- No multi-object Stripe write support in the first slice.
- No CDC/logical replication yet.
- No bidirectional sync or writeback to the source database.

Those can come later if the basic model works.

## MVP User Flow

A developer has a CRM customer table:

```
crm_customers
  id                 text primary key
  email              text
  name               text
  company_name       text
  plan               text
  updated_at         timestamptz
```

They configure a pipeline:

```json
{
  "source": {
    "type": "postgres",
    "postgres": {
      "url": "postgres://...",
      "stream": "crm_customers",
      "schema": "public",
      "table": "crm_customers",
      "primary_key": ["id"],
      "cursor_field": "updated_at"
    }
  },
  "destination": {
    "type": "stripe",
    "stripe": {
      "api_key": "sk_test_...",
      "api_version": "2025-...",
      "object": "customer",
      "mode": "upsert",
      "allow_create": true,
      "identity": {
        "external_id_field": "id",
        "metadata_key": "crm_customer_id"
      },
      "fields": {
        "email": "email",
        "name": "name",
        "metadata[company_name]": "company_name",
        "metadata[plan]": "plan"
      }
    }
  },
  "streams": [
    {
      "name": "crm_customers",
      "sync_mode": "incremental"
    }
  ]
}
```

The sync runs:

1. `source-postgres` selects rows ordered by `(updated_at, id)`.
2. It emits each row as a `record`.
3. It emits `source_state` after a page boundary.
4. `destination-stripe` maps each row to a Stripe Customer write.
5. It looks up by managed metadata identity.
6. If no match exists and `allow_create` is true, it creates a Customer.
7. It re-emits `source_state` only after the prior Stripe writes have succeeded.

## Identity Model

Identity is the product surface here. If this is wrong, we mutate the wrong Stripe Customer.

For the MVP, I would make the rules strict:

1. Prefer an explicit Stripe ID field from the source row.
2. Otherwise use a managed external ID stored in Stripe metadata.
3. Do not use email as the primary identity key.
4. If lookup returns multiple matches, fail the record or stream.
5. Only create when `allow_create` is explicitly true.

Example managed metadata:

```json
{
  "metadata": {
    "crm_customer_id": "crm_123",
    "reverse_etl_source": "postgres",
    "reverse_etl_stream": "crm_customers"
  }
}
```

This is good enough for an MVP. It avoids the worst footguns while keeping the system understandable.

Longer term, metadata search is not enough. Stripe Search can be eventually consistent, and metadata is not a durable mapping store. If reverse ETL becomes a real product surface, we probably need destination-owned state for mappings like:

```
pipeline_id + stream + source_primary_key -> stripe_object_id
```

The protocol already has a `destination` section in sync state, but the reducer does not really persist destination-owned state today. I would not solve that in the first slice unless the MVP cannot avoid it.

## Write Safety

Stripe writes are not database upserts.

Different objects have different create/update APIs, immutable fields, side effects, rate limits, and delete semantics. So the first connector should be allow-listed and boring.

For Customers:

- Only support `customer` initially.
- Only support create/update, not delete.
- Only write configured fields.
- Merge only configured metadata keys.
- Do not clear fields unless the config explicitly says null means clear.
- Use deterministic idempotency keys.
- Respect `Retry-After` and retry 429/5xx/network failures.
- Treat most 4xx responses as mapping/config errors.

Checkpoint rule:

```
Never advance the source cursor until destination-stripe has committed all prior writes for that stream.
```

That matches how `destination-postgres` already behaves. It buffers records, flushes them, then passes through `source_state`.

## Failure Behavior

The MVP should fail loud.

| Case                          | Behavior                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| Missing required mapped field | Emit stream/record error. Do not advance checkpoint past the failed write. |
| Stripe 400 validation error   | Treat as config/data error. Do not retry forever.                          |
| Stripe 401/403                | Fail the run. Config or permission problem.                                |
| Stripe 429                    | Retry with `Retry-After` and backoff.                                      |
| Stripe 5xx/network timeout    | Retry with stable idempotency key.                                         |
| Ambiguous identity match      | Fail closed. Do not guess.                                                 |
| Source row deleted            | Ignore for MVP, or fail if delete handling is requested.                   |

One subtle case:

If Stripe creates the Customer but the network dies before we see the response, idempotency keys help. They are not a full mapping system, but they make retries much safer.

## Why This Fits The Existing Abstraction

The current connector model is directional but not Stripe-specific.

Forward sync:

```
source-stripe -> destination-postgres
```

Reverse ETL:

```
source-postgres -> destination-stripe
```

The same protocol works if we keep the contract simple:

- Sources own source cursors.
- Destinations own write durability.
- State only advances after destination commit.
- Connector-specific behavior stays inside the connector.

This also keeps connector isolation intact. `source-postgres` should not know anything about Stripe. `destination-stripe` should not know anything about Postgres. They meet at the catalog and record stream.

## Where The Abstraction Is Thin

There are real gaps.

The biggest one is destination state. Today the engine state has room for destination state, but the reducer only persists source state. That means the MVP should not depend on durable destination mappings unless we build that path first.

The second gap is mapping. A generic transform layer would be useful eventually, but it is probably premature. For this MVP, put Customer field mapping in `destination-stripe` config. If we later support multiple reverse ETL destinations, we can pull mapping into a shared transform step.

The third gap is object semantics. `destination-postgres` can treat records like rows. `destination-stripe` cannot treat every Stripe object the same way. Each object type needs its own write plan.

## Suggested Build Plan

Phase 1: design doc and fake-server tests

- Write down the Customer-only config shape.
- Build fake Stripe server tests for create, update, retry, and ambiguous lookup.
- Define the checkpoint behavior before writing connector code.

Phase 2: `source-postgres`

- Read one table or query.
- Require `primary_key` and `cursor_field`.
- Page deterministically by `(cursor_field, primary_key)`.
- Emit catalog with primary key and `newer_than_field`.
- Emit `source_state` at page boundaries.

Phase 3: `destination-stripe`

- Support Customer only.
- Map configured fields into create/update params.
- Update by Stripe ID when present.
- Otherwise lookup/create using managed metadata identity.
- Re-emit `source_state` after writes succeed.

Phase 4: engine integration

- Register connectors in default engine connectors.
- Add an integration test:
  - seed Postgres customer rows
  - run pipeline into fake Stripe
  - simulate failure after a write
  - resume
  - prove no duplicate Customers

## Open Questions

- Is Customer create allowed in the first version, or should MVP be update-only?
- Is metadata identity enough for the first version, or do we need destination-owned mapping state immediately?
- Is this intended to be developer-only config, or do we need to shape it for a future UI?
- Should failed records block the whole stream, or should we add a dead-letter/error report concept?
- How much PII do we want to allow by default?

My bias:

- Allow create, but only behind `allow_create: true`.
- Support Stripe ID first, metadata identity second.
- Keep it developer-configured.
- Fail the stream on record errors for MVP.
- Field allowlist everything.

## Decision I Want From The Team

I think we should build the Customer-only MVP.

The bet is small and useful:

- It tests whether reverse ETL fits the current engine.
- It gives us a real demo path: CRM table to Stripe Customers.
- It does not require a protocol rewrite.
- It exposes the right hard problems early: identity, idempotency, checkpointing, and write safety.

If this works, the next product questions become much clearer:

- Do we want a mapping UI?
- Do we need destination-owned mapping state?
- Which Stripe objects are worth supporting next?
- Do customers need CDC, schedules, preview, dry-run, or audit logs first?

Short version: build the boring Customer upsert path, make it safe, and learn from the real constraints before turning it into a platform.
