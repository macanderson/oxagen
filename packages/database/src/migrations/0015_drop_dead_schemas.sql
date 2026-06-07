-- Migration 0015: Drop dead schemas and tables
-- Sunsets 6 table groups identified as never-used in release audit

-- Drop execution schema entirely (executions, execution_steps, tool_calls)
DROP SCHEMA IF EXISTS execution CASCADE;

-- Drop workflow playbooks (templated workflows, never wired)
DROP TABLE IF EXISTS workflow.playbooks CASCADE;
DROP TABLE IF EXISTS workflow.playbook_versions CASCADE;
DROP TABLE IF EXISTS workflow.playbook_steps CASCADE;

-- Drop event triggers (event-driven rules, capability deferred)
DROP TABLE IF EXISTS event.triggers CASCADE;

-- Drop integration connections (third-party connectors, marketplace deferred)
DROP TABLE IF EXISTS integration.connections CASCADE;

-- Drop content documents (workspace docs, semantic layer never wired)
DROP TABLE IF EXISTS content.documents CASCADE;

-- Drop agent tools (static catalog, discovery is dynamic from MCP)
DROP TABLE IF EXISTS agent.tools CASCADE;
