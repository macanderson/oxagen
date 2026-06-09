-- Migration: 0004_drop_dead_tables
-- Release-audit Check 4 FAIL remediation: remove 5 tables that have schema
-- definitions, RLS manifest entries, and Drizzle relations but ZERO CRUD
-- reads/writes in any domain route, handler, or seed code. Verified by
-- exhaustive grep across all apps/* and packages/* (excluding test/e2e).
--
-- Dropped tables:
--   agent.tool_assignments        — no domain reads/writes; junction was unused
--   agent.tool_versions           — no domain reads/writes; e2e fixture only
--   workflow.playbook_step_assignments — no domain reads/writes
--   event.workflow_triggers       — no domain reads/writes
--   execution.execution_artifacts — no domain reads/writes
--
-- CASCADE handles any dependent objects (indexes, FK constraints from
-- agent.tool_assignments → agent.tool_versions, etc.).

SET search_path TO public;

-- Drop agent.tool_assignments first (has FK → agent.tool_versions).
DROP TABLE IF EXISTS agent.tool_assignments CASCADE;

-- Drop agent.tool_versions (referenced app-only by execution.tool_calls,
-- which carries no DB-level FK constraint — only an index).
DROP TABLE IF EXISTS agent.tool_versions CASCADE;

-- Drop workflow.playbook_step_assignments.
DROP TABLE IF EXISTS workflow.playbook_step_assignments CASCADE;

-- Drop event.workflow_triggers.
DROP TABLE IF EXISTS event.workflow_triggers CASCADE;

-- Drop execution.execution_artifacts.
DROP TABLE IF EXISTS execution.execution_artifacts CASCADE;
