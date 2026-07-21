-- Authenticated, content-free Stella execution rollups. Tenant columns are
-- stamped from ambient Oxagen scope by chInsert, never from Stella labels.
-- Repeated delivery of one immutable event_id collapses at exact-read time
-- under FINAL with cross-partition merging enabled. received_at is server-owned
-- and selects the latest retry; background merges do not cross month partitions.
CREATE TABLE IF NOT EXISTS stella_operational_events (
  org_id UUID,
  workspace_id UUID,
  schema LowCardinality(String),
  event_class LowCardinality(String),
  event_id String,
  enrollment_id String,
  provider LowCardinality(String),
  model LowCardinality(String),
  outcome LowCardinality(String),
  duration_ms UInt64,
  input_tokens UInt64,
  output_tokens UInt64,
  cost_microusd UInt64,
  tool_call_count UInt64,
  changed_file_count UInt64,
  produced_output Bool,
  received_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(received_at)
ORDER BY (org_id, workspace_id, event_id);
