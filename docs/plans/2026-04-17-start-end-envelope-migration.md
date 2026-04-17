# Start/End Envelope Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce explicit client/engine `start` and `end` messages as a
follow-up phase without blocking the current `eof`-based lifecycle rollout.

**Architecture:** Phase 1 keeps the existing sync entrypoints and terminal
`eof` message, preserving `eof.reason` and adding `has_more`. Phase 2 layers an
explicit `start` request and `end` terminal message on top of the same
lifecycle semantics and engine state, then migrates callers incrementally
before considering any rename or deprecation of `eof`.

**Tech Stack:** TypeScript, Zod, `packages/protocol`, `apps/engine`,
`apps/service`, docs, tests.

---

### Task 1: Freeze The Current Phase Boundary

**Files:**

- Modify: `docs/engine/sync-lifecycle.md`
- Modify: `docs/engine/sync-lifecycle-source-stripe.md`
- Create: `docs/plans/2026-04-17-start-end-envelope-migration.md`

**Step 1: Document phase 1**

State that phase 1 keeps the existing sync request entrypoints and terminal
`eof`.

**Step 2: Preserve terminal semantics**

Document that `eof.reason` remains authoritative for why a request stopped, and
`has_more` is the continuation signal.

**Step 3: Defer envelope cleanup**

Move `start`, `end`, and `sync_run_id` out of the phase-1 lifecycle doc so the
current plan stays focused on source/engine lifecycle semantics.

### Task 2: Add Explicit Protocol Aliases

**Files:**

- Modify: `packages/protocol/src/protocol.ts`
- Modify: `apps/engine/src/lib/pipeline.ts`
- Modify: `apps/engine/src/lib/backfill.ts`
- Test: `apps/engine/src/lib/progress.test.ts`
- Test: `apps/engine/src/lib/engine.test.ts`

**Step 1: Add `StartPayload`**

Define a client → engine `start` payload that aliases the existing request
shape instead of replacing it.

**Step 2: Add `EndPayload`**

Define an engine → client `end` payload as an alias of terminal `eof`,
preserving `reason`, `has_more`, and continuation state.

**Step 3: Keep dual compatibility**

Ensure the engine can emit and consume the explicit envelope without removing
legacy `eof`.

### Task 3: Migrate Call Sites

**Files:**

- Modify: `apps/service/src/api/app.ts`
- Modify: `apps/engine/src/api/app.ts`
- Modify: client call sites that consume sync output
- Test: relevant API and integration tests

**Step 1: Update internal callers**

Teach internal callers to understand the explicit `start` / `end` envelope or
the legacy `eof` alias.

**Step 2: Preserve compatibility at boundaries**

Do not break existing clients while the migration is in progress.

**Step 3: Add integration coverage**

Add tests that prove both forms behave identically for continuation and
terminality.

### Task 4: Decide The Long-Term `eof` Story

**Files:**

- Modify: `docs/engine/sync-lifecycle.md`
- Modify: `packages/protocol/src/protocol.ts`
- Modify: migration / compatibility docs as needed

**Step 1: Choose the permanent contract**

Decide whether `eof` remains a permanent alias of `end` or becomes legacy-only.

**Step 2: Measure adoption**

If deprecating `eof`, add enough logging or metrics to confirm no callers still
depend on the old name.

**Step 3: Remove only after migration**

Do not remove `eof` until every supported caller has switched.
