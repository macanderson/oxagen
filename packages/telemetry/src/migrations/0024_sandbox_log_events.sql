-- 0024_sandbox_log_events.sql
--
-- Durable-sandbox command output for the sandbox inspector
-- (spec: docs/specs/sandbox-session-lifecycle/spec.md §5.2 / §7.2).
--
-- One row per line of a coding-session command's stdout/stderr, plus one
-- 'system'/'debug' line per command (command echo + exit code + duration). The
-- inspector's log console reads this; its Debug toggle filters on `level`
-- ('normal' program output vs 'debug' plumbing). Tenant-scoped, 14-day TTL,
-- keyed by the opaque session public id (sbx_…). Idempotent CREATE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS sandbox_log_events (
  ts DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1)),
  org_id UUID,
  workspace_id UUID,
  session_id String,
  stream LowCardinality(String),
  level LowCardinality(String),
  command String CODEC(ZSTD(3)),
  seq UInt32,
  line String CODEC(ZSTD(3)),
  exit_code Nullable(Int32),
  duration_ms Nullable(UInt32)
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(ts)
ORDER BY (org_id, workspace_id, session_id, ts)
TTL toDateTime(ts) + INTERVAL 14 DAY;
