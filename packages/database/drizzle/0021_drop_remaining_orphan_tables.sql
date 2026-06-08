-- Drop remaining orphan tables that were created but never wired to any handler or route.
-- These were identified during schema audit (Phase 4 check 4 in release-audit).
-- Tables: content.documents, agent.tools, workflow.playbooks, event.triggers,
-- integration.connections, and the entire execution schema with its tables.
--
-- Migration 0015 in src/migrations/ was intended to drop these but src/migrations/
-- is unreachable by db-migrate (which only reads from drizzle/). This migration
-- completes that cleanup atomically.

DROP TABLE IF EXISTS execution.execution_artifacts CASCADE;
DROP TABLE IF EXISTS execution.tool_calls CASCADE;
DROP TABLE IF EXISTS execution.execution_steps CASCADE;
DROP TABLE IF EXISTS execution.executions CASCADE;
DROP SCHEMA IF EXISTS execution CASCADE;

DROP TABLE IF EXISTS integration.connections CASCADE;
DROP SCHEMA IF EXISTS integration CASCADE;

DROP TABLE IF EXISTS event.workflow_triggers CASCADE;
DROP TABLE IF EXISTS event.triggers CASCADE;
DROP SCHEMA IF EXISTS event CASCADE;

DROP TABLE IF EXISTS workflow.playbook_step_assignments CASCADE;
DROP TABLE IF EXISTS workflow.playbook_steps CASCADE;
DROP TABLE IF EXISTS workflow.playbook_versions CASCADE;
DROP TABLE IF EXISTS workflow.playbooks CASCADE;
DROP SCHEMA IF EXISTS workflow CASCADE;

DROP TABLE IF EXISTS agent.tools CASCADE;
DROP TABLE IF EXISTS agent.tool_versions CASCADE;
DROP TABLE IF EXISTS agent.tool_assignments CASCADE;

DROP TABLE IF EXISTS content.documents CASCADE;
