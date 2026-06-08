-- 0020: Drop orphan agent execution tables created in 0019 but never wired to domain code.
-- Migration 0019 created agent_executions, agent_execution_steps, and agent_tool_calls
-- with full RLS + relations, but zero references exist in any handler, service, or query path.
-- Inngest supervisor and execution orchestration were never implemented.
-- Dropping the orphan schema to satisfy "no dead code, no dead tables" requirement.

DROP TABLE agent.agent_tool_calls CASCADE;
DROP TABLE agent.agent_execution_steps CASCADE;
DROP TABLE agent.agent_executions CASCADE;
