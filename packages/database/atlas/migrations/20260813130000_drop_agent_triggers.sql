-- Drop agent.agent_triggers (#1010 / OXA-2137): triggers belong to
-- automations/playbooks, not agents. This subsystem is fully removed —
-- the agent.trigger.* CRUD, contracts, API routes, and MCP tools are deleted
-- in the same change. workflow.playbook_triggers is now the sole triggering
-- surface.
--
-- Data loss is intentional and approved: any rows in agent_triggers describe
-- bindings that no longer have a runtime path to fire them once the CRUD
-- surface above is removed, so retaining the table would be dead state.
DROP TABLE IF EXISTS "agent"."agent_triggers";
