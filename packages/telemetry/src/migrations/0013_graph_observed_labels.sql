-- 0013_graph_observed_labels.sql
--
-- See docs/specs/workspace-schema-registry/spec.md §4.9: graph_observed_labels (ClickHouse)
--
-- Replaces the durable observation role of ingestion.entity_types (§1.3, §3.1).
-- Emitted by ingestion as it writes nodes/relationships; read by schema.recommend
-- to derive a starter schema recommendation.
--
-- The recommender aggregates by (label_or_type, target_kind) to get counts and
-- the most common property_keys across observed instances — enabling the AI to
-- propose labels + properties grounded in what the workspace's graph actually has.
--
-- Engine: MergeTree (append-only; no deduplication needed — each ingestion event
-- is a distinct observation). Partitioned by month for efficient range scans.
-- ORDER BY (org_id, workspace_id, target_kind, label_or_type, occurred_at)
-- keeps aggregation queries on observed labels fast for a given workspace.
--
-- TTL: 1 year — observation data older than a year is unlikely to influence
-- schema recommendations and accumulates fast under high-volume ingestion.

CREATE TABLE IF NOT EXISTS graph_observed_labels
(
    -- Dedup key (best-effort; MergeTree is append-only so event_id is advisory).
    event_id            UUID,
    org_id              UUID,
    workspace_id        UUID,
    -- 'node' or 'relationship'
    target_kind         LowCardinality(String),
    -- The node label (e.g. "Customer") or relationship type (e.g. "SIGNED_CONTRACT")
    -- that was observed during this ingestion write.
    label_or_type       String,
    -- Property keys present on the observed node or relationship instance.
    property_keys       Array(String),
    -- Source connection that produced this observation (nullable — may be null for
    -- direct graph.node.upsert / graph.relationship.upsert calls).
    connection_id       Nullable(UUID),
    -- The connector record type / entity class (e.g. "Deal", "Contact") that mapped
    -- to this label — useful for recommendation rationale.
    source_record_type  LowCardinality(String) DEFAULT '',
    occurred_at         DateTime64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (org_id, workspace_id, target_kind, label_or_type, occurred_at)
TTL toDateTime(occurred_at) + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;
