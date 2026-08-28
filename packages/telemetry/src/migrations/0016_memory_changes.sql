-- 0016_memory_changes.sql
--
-- Creates the memory_changes table for auditable memory weight/decay events.
-- One row per memory confidence change (reinforced, decayed, manually_promoted,
-- manually_forgotten). Used by memory-decay policies.
--
-- Engine: MergeTree (append-only analytics). TTL 365 days.

CREATE TABLE IF NOT EXISTS memory_changes (
  change_id          UUID                        NOT NULL,
  org_id             UUID                        NOT NULL,
  workspace_id       UUID                        NOT NULL DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  memory_id          UUID                        NOT NULL,
  node_ref           String                      NOT NULL DEFAULT '',
  cause              LowCardinality(String)      NOT NULL,
  confidence_before  Float32                     NOT NULL DEFAULT 0.0,
  confidence_after   Float32                     NOT NULL DEFAULT 0.0,
  occurred_at        DateTime64(3)               NOT NULL
) ENGINE = MergeTree()
ORDER BY (org_id, memory_id, occurred_at)
TTL toDateTime(occurred_at) + INTERVAL 365 DAY;
