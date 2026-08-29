-- 0021_schema_conformance_events_idempotency.sql
--
-- Idempotent ClickHouse conformance events under Inngest retries.
--
-- ROOT CAUSE
--   `upsertEntityNode` (packages/ingestion/src/mutations/upsert-entity.ts) is
--   invoked from a SINGLE `step.run("upsert-node", ...)` in the ingestion
--   pipeline (packages/inngest-functions/src/functions/ingestion.pipeline.ts).
--   When Inngest retries that step (transient Neo4j/network failure — expected,
--   not itself a bug), the WHOLE step body re-executes, including the
--   `emitConformanceEvent` / `emitConformanceLowEvent` ClickHouse inserts. Each
--   call minted `event_id: randomUUID()`, so a retried step wrote a BRAND NEW
--   row for the exact same logical write — permanently double- (or multi-)
--   counting the same conformance decision in every schema/conformance
--   aggregate. schema_conformance_events was already called out (by name) in
--   idempotency.ts's incident writeup as one of the tables affected by this
--   class of defect; this migration is the actual fix landing for it.
--
-- FIX (two parts, applied together — see upsert-entity.ts for the code half)
--   1. event_id is now derived deterministically via
--      `deterministicEventId(runId, naturalKey, versionId, outcome, role)`
--      (packages/telemetry/src/idempotency.ts — the SAME convention already
--      used by agent.background-task.execute.ts / agent.workflow.task.execute.ts
--      / playbook.run.execute.ts). `runId` is the Inngest run id: STABLE across
--      every retry of the SAME run, but a FRESH value on the next genuinely
--      separate ingestion of the same entity (e.g. tomorrow's poll cycle) — so
--      retries collapse while legitimate repeat observations over time do not.
--   2. This table moves from plain MergeTree (append-only, no dedup) to
--      ReplacingMergeTree(occurred_at) with `event_id` as the trailing/most
--      granular ORDER BY component — mirrors the eval_runs precedent
--      (`ENGINE = ReplacingMergeTree(updated_at) ... run_id` last in the key;
--      see schema.sql). A retried insert with the same event_id now collapses
--      into the original row on merge; query with FINAL for exact counts
--      (background merges are eventually-consistent — see audit_events FINAL
--      usage in latestAuditChainHash for the established read pattern).
--
-- WHY DROP + RECREATE (not ALTER)
--   ClickHouse forbids `ALTER TABLE ... MODIFY ENGINE` for the MergeTree
--   family (MergeTree -> ReplacingMergeTree needs a new table), and the new
--   ORDER BY removes `occurred_at` from the middle of the old key rather than
--   appending — also unsupported by `ALTER ... MODIFY ORDER BY` (extension-only;
--   see 0012's comment on the identical constraint for token_usage). This table
--   is best-effort telemetry with a 90-day TTL and every insert site already
--   swallows errors (`// conformance telemetry must never break ingestion`), so
--   a one-time rebuild (losing at most 90 days of non-critical dashboard
--   history) is the same acceptable tradeoff 0010_drop_dead_tables.sql already
--   established for this package, and far cheaper than a live INSERT-SELECT
--   migration for a table with no durable/billing dependents.
--
-- All statements remain idempotent (DROP TABLE IF EXISTS / CREATE TABLE IF NOT
-- EXISTS), consistent with every other file in this directory.

DROP TABLE IF EXISTS schema_conformance_events;

CREATE TABLE IF NOT EXISTS schema_conformance_events
(
    -- Deterministic (NOT crypto.randomUUID()) — see upsert-entity.ts. Doubles as
    -- the table's dedup key via its trailing position in ORDER BY below.
    event_id            UUID,
    org_id              UUID,
    workspace_id        UUID,
    -- The pinned schema_registry.schema_versions.id at write time.
    version_id          UUID,
    -- 'node' or 'relationship'
    target_kind         LowCardinality(String),
    -- For nodes: the Neo4j node internal id string; for relationships: a composite key
    -- (e.g. "startId:type:endId") — used for drill-down, not a durable FK.
    node_id             Nullable(String),
    relationship_key    Nullable(String),
    -- The node label or relationship type name that was validated.
    node_label          String,
    -- Enforcement mode in effect at write time (copied from registries.enforcement_mode).
    enforcement_mode    LowCardinality(String),
    -- The enforcement decision (see outcomes in the original 0014 header comment).
    outcome             LowCardinality(String),
    -- 0.0–1.0 conformance score: fraction of required properties present and correctly typed.
    conformance_score   Float32,
    -- Required property keys that were absent from the written payload.
    missing_required    Array(String),
    -- Type-mismatch error messages (e.g. "age: expected integer, got string").
    type_errors         Array(String),
    -- Source connection that produced the write (nullable).
    connection_id       Nullable(UUID),
    -- Connector record type / entity class that was being ingested.
    source_record_type  LowCardinality(String) DEFAULT '',
    occurred_at         DateTime64(3)
)
ENGINE = ReplacingMergeTree(occurred_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (org_id, workspace_id, version_id, node_label, event_id)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
