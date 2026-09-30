-- 0037_served_tool_calls.sql
--
-- One row per call a wrapped agent makes to a published server's tool through
-- Oxagen's served tools (ADR-234, #4678). MCP Studio's tool panel reads it for
-- agent feedback: how many calls a tool took, how many the tool's input
-- schema refused, how many came back as error results, and how many were
-- retries after one of those.
--
-- Why a table of its own and not tool_invocations: tool_invocations is shaped
-- for the in-app agent. Its message_id is a required UUID, its
-- external_server_id is a UUID, and packages/telemetry/README.md forbids a
-- made-up key in execution_step_id. A served call has no message, names its
-- server by the folder name, and belongs to a tacho session's public id.
--
-- Append-only, like every table in this store. Tenant-scoped: written through
-- chInsert, which stamps org_id and workspace_id from the active scope, and
-- read through chSelect, which filters on both. ORDER BY leads with
-- (org_id, workspace_id, server, tool) because the Studio read names one
-- server and groups by tool.
--
-- Retained 180 days, as tool_invocations is. The Studio read looks back 30.
CREATE TABLE IF NOT EXISTS served_tool_calls (
  org_id UUID,
  workspace_id UUID,

  -- The server's name in the published manifest, which is its steering
  -- folder's name: billing.
  server LowCardinality(String),
  -- The full tool name: billing__create_refund. A reflection's tool_feedback
  -- names a tool the same way.
  tool String,
  -- `tse_...`: the tacho session the call belongs to, as memory_reflections
  -- names its run. Empty when the request named no session, and such a row is
  -- never counted as a retry.
  run_public_id String DEFAULT '',

  -- How the gateway metered the call: allowed, denied, parked, or failed.
  outcome LowCardinality(String),
  -- Why the call did not do what the agent asked, when the tool is the reason:
  -- schema_rejected (the tool's input schema refused the arguments) or
  -- error_result (the tool ran and returned an error result). A denial
  -- because Cedar could not read the arguments is schema_rejected too. Empty
  -- otherwise, including a refusal by policy, billing, or the route.
  problem LowCardinality(String) DEFAULT '',

  created_at DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, server, tool, created_at)
TTL toDateTime(created_at) + INTERVAL 180 DAY;
