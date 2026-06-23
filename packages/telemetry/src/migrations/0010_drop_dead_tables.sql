-- 0010_drop_dead_tables.sql
--
-- Remove five telemetry tables that have ZERO readers AND ZERO writers
-- anywhere in the repo (verified by grep across apps/ + packages/, excluding
-- the telemetry package's own src/dist, migrations, schema.sql, and tests):
--
--   traces, spans          — no FROM, no insertTraces/insertSpans callers
--   api_key_events         — no FROM, no insertApiKeyEvents callers
--   agent_logs             — no FROM, no insertAgentLogs callers
--   session_recaps         — never referenced outside its own 0005 migration
--
-- claude_sessions is intentionally KEPT (it has a writer:
-- tools/scripts/backfill-claude-telemetry.ts). events/execution_logs/
-- token_usage/tool_invocations/skill_loads/audit_events all have live writers
-- and stay.
--
-- DROP TABLE IF EXISTS is idempotent. These were unconsumed, so no data of
-- value is lost. The TS inserter fns + row types + barrel re-exports for the
-- dropped tables are deleted in the same commit (no dead code left behind).

DROP TABLE IF EXISTS traces;
DROP TABLE IF EXISTS spans;
DROP TABLE IF EXISTS api_key_events;
DROP TABLE IF EXISTS agent_logs;
DROP TABLE IF EXISTS session_recaps;
