-- 0008_skill_loads.sql
--
-- Skill lifecycle telemetry. One row per skill load — emitted when a
-- workspace skill is loaded into an agent run (agent.skill.load) or surfaced
-- through any other entry point. Powers the skill.metrics.read handler: loads
-- per skill, loads per version, and last-used.
--
-- Mirrors the canonical definition in schema.sql; this versioned file applies
-- the same CREATE to existing deployments. Idempotent (CREATE IF NOT EXISTS).
--
-- org/workspace/skill are denormalized so metrics query in isolation without a
-- Postgres join. skill_version is the integer skill version (UInt32).
-- execution_step_id ties the load to a run step when one is in scope (NULL for
-- standalone loads). load_latency_ms is NULL when the loader did not measure it.

CREATE TABLE IF NOT EXISTS skill_loads (
  org_id String,
  workspace_id String,
  skill_id String,
  skill_slug String,
  skill_version UInt32,
  execution_step_id Nullable(String),
  surface String,
  load_latency_ms Nullable(UInt32),
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, skill_id, created_at);
