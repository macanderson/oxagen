-- 0014_schema_conformance_events.sql
--
-- See docs/specs/workspace-schema-registry/spec.md §4.10: schema_conformance_events (ClickHouse)
--
-- Per-write conformance telemetry emitted during property-level validation
-- (§2.1 criteria 9). NOT in Postgres — these are high-volume runtime events.
--
-- Emitted by the ingestion validator (upsertEntityNode) on every node/relationship
-- write when a workspace has a pinned schema version and enforcement_mode != 'off'.
-- The `outcome` column records the enforcement decision for the write.
--
-- outcomes:
--   accepted          — all required properties present, types valid, score >= floor
--   rejected          — strict mode: write blocked (non-conforming payload rejected)
--   written_below_floor — lenient mode: written despite score < conformance_floor
--                        (triggers schema.conformance.low event)
--   pruned            — a reconcile worker removed an off-schema property
--
-- Engine: MergeTree (append-only). Partitioned by month.
-- ORDER BY (org_id, workspace_id, occurred_at) — primary aggregation axis is
-- workspace over time; version_id and node_label as secondary for drill-down.
--
-- TTL: 90 days — conformance telemetry is operational; long-term trends come from
-- aggregated metrics (not raw events). 90 days covers a typical compliance window.

CREATE TABLE IF NOT EXISTS schema_conformance_events
(
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
    -- The enforcement decision (see outcomes in header comment).
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
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (org_id, workspace_id, occurred_at, version_id, node_label)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
