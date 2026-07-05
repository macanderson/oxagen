---
name: schema-conformance-events-inngest-retry-double-count
type: bug
domain: ingestion
severity: P2
linear: OXA-1932
date: 2026-07-04
---

**Symptom:** `schema_conformance_events` (ClickHouse) double- or multi-counted the
same logical schema-conformance decision, skewing conformance/dashboard
aggregates whenever an Inngest step retried under transient failure —
increasingly visible in high-retry conditions.

**Root cause:** `upsertEntityNode` (packages/ingestion/src/mutations/upsert-entity.ts)
is invoked from a single `step.run("upsert-node", ...)` in
packages/inngest-functions/src/functions/ingestion.pipeline.ts. Inngest retries
re-execute the WHOLE step body on failure, including the
`emitConformanceEvent` / `emitConformanceLowEvent` ClickHouse inserts inside
`upsertEntityNode`. Each call minted `event_id: crypto.randomUUID()`, so a
retried step wrote a brand-new row for the exact same logical write. The
table was also a plain (non-Replacing) `MergeTree`, so even a deterministic id
would not have collapsed on its own. `packages/telemetry/src/idempotency.ts`
already documented this exact defect class (and named
`schema_conformance_events` explicitly) from an earlier incident fixing
`events`/`tool_invocations` in `agent.background-task.execute.ts` /
`agent.workflow.task.execute.ts` / `playbook.run.execute.ts` — this ticket
finally lands the fix for the one table the writeup called out but never
patched.

**Fix (both code + schema, PR fix/oxa-1932-clickhouse-conformance-idempotency):**
1. `event_id` is now `deterministicEventId(runId, naturalKey, versionId, outcome, role)`
   (`@oxagen/telemetry`'s existing `deterministicEventId` — do not reinvent this,
   it's the established convention). `runId` is Inngest's `ctx.runId`, threaded
   from `ingestion.pipeline.ts`'s handler (`async ({ event, step, runId }) => …`)
   through `UpsertEntityOptions.runId` — stable across every retry of ONE
   execution, but a fresh value on the next genuinely separate trigger (e.g.
   next sync cycle re-observing the same entity), so retries collapse while
   legitimate repeat observations over time still get their own row. `role`
   ("result" | "low_alert") keeps the below-floor alert marker row's id
   distinct from the primary outcome row's id even though both can share the
   same outcome value.
2. `schema_conformance_events` moved from `MergeTree` to
   `ReplacingMergeTree(occurred_at)` with `event_id` as the LAST/most granular
   `ORDER BY` component (mirrors the `eval_runs` precedent —
   `ReplacingMergeTree(updated_at) … run_id` last in the key — see
   packages/telemetry/src/schema.sql). Migration
   `packages/telemetry/src/migrations/0021_schema_conformance_events_idempotency.sql`
   does `DROP TABLE IF EXISTS` + recreate (ClickHouse forbids `ALTER … MODIFY
   ENGINE` for the MergeTree family and forbids removing a column from the
   middle of an existing `ORDER BY` — full rebuild is the only path; acceptable
   here because the table is best-effort 90-day-TTL telemetry with no
   durable/billing dependents, same tradeoff `0010_drop_dead_tables.sql`
   already established for this package).

**Guard:** `packages/ingestion/src/mutations/__tests__/upsert-entity.test.ts`
("conformance-event idempotency (OXA-1932)" describe block) — unit tests
against the REAL `deterministicEventId` (only `chInsert` is mocked) proving:
same runId+inputs → same event_id across two calls (retry simulation); the
alert row's event_id differs from the primary row's even when both share
`outcome="written_below_floor"`; different runId → different event_id; no
runId falls back to a fixed sentinel (still deterministic, not random). Plus
`packages/telemetry/src/schema-conformance-idempotency.integration.test.ts` —
runs `migrate()` against the REAL local ClickHouse (:8123; skips cleanly if
unreachable, matching `lease.integration.test.ts`'s Postgres pattern) and
proves the actual `ReplacingMergeTree` merge collapses two inserts sharing one
`event_id` into one row (`OPTIMIZE TABLE … FINAL` + `SELECT count() … FINAL`),
while two DIFFERENT `event_id`s (simulating separate ingestion runs) do NOT
collapse. This second test is necessary because ClickHouse merge/dedup
behavior cannot be verified by a mock — this repo has already been burned by
mocked-ClickHouse tests passing invalid SQL undetected (see
`clickhouse-mocked-tests-miss-sql` memory).

**Watch-outs:**
- `packages/ingestion/src/pipeline.ts`'s `runPipeline`/`PipelineContext`
  (which threads `pinnedSchema` through `resolveEntity`) has ZERO call sites
  anywhere in the repo — dead/unwired code. The LIVE Inngest ingestion
  function (`ingestion.pipeline.ts`) never resolves or passes `pinnedSchema`
  into `upsertEntityNode` at all today, so schema validation / conformance
  events do not actually fire from the live path yet. That's a separate,
  pre-existing gap (not caused by and out of scope for this fix) — flag it if
  you're asked to "wire the schema registry into ingestion."
- `packages/ingestion/src/dedup/resolve.ts`'s alias-creation paths also call
  `upsertEntityNode(mutation, orgId, opts)` but are never given a `runId`
  (their caller, `resolveEntity`, has no `runId` param) — those calls degrade
  to the same "no-inngest-run-id" deterministic sentinel as before this fix.
  Not a regression, but if `resolveEntity` callers are ever wired with a live
  Inngest run context, thread `runId` there too for the same collision-safety
  properties.
- ClickHouse ReplacingMergeTree dedup is only guaranteed after a merge (or
  `OPTIMIZE … FINAL` / reading with `FINAL`) — background merges are
  eventually consistent. Any new reader of `schema_conformance_events` for
  exact counts must query with `FINAL` (see `latestAuditChainHash`'s
  established pattern on `audit_events FINAL`).
