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

-- THESE DROPS STAY (#2972)
--   All five are replay-safe: nothing after this file recreates any of them,
--   so a re-run drops absent tables. The ledger in migrate.ts skips the file
--   on an existing deployment regardless.
--
--   They are not removable either. traces, spans, api_key_events and
--   agent_logs have no CREATE left anywhere in schema.sql or migrations/, so
--   those four lines are already inert on a fresh database and deleting them
--   would buy nothing while losing the record of what went and why.
--   session_recaps is different: 0005_session_telemetry.sql still creates it,
--   so on a fresh database its DROP below is the only thing that removes it.

DROP TABLE IF EXISTS traces;
DROP TABLE IF EXISTS spans;
DROP TABLE IF EXISTS api_key_events;
DROP TABLE IF EXISTS agent_logs;
DROP TABLE IF EXISTS session_recaps;
