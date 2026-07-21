-- agent.agent_runs — carry the resolved AGENT/HUMAN principal pair for a
-- deployed-agent run (docs/specs/agent-rbac/spec.md §3.1/§3.4). Run records
-- already carry lineage (runId/parentRunId elsewhere) — this does NOT create
-- a principal per run. It denormalizes a reference to the two
-- ALREADY-EXISTING principals (the agent's one persistent identity principal
-- — agent.agents.principal_id — and the invoking human's principal) onto the
-- run row so a cross-org worker claiming this row (withSystemDb, no tenant
-- session) can reconstruct the AuthzContext pair without a second lookup.
--
-- Nullable: a bare conversational turn (no deployed agent behind it) carries
-- neither column, exactly as it does today.
--
-- App-enforced references (no FK): iam.principals lives in a different
-- Postgres schema, and CLAUDE.md storage rules forbid cross-schema FKs —
-- same convention as agents.principal_id (20260805120000).
--
-- Hand-written + `atlas migrate hash` (see 20260804100000 module comment —
-- `atlas migrate diff` is broken by the unresolved pg_trgm fresh-replay
-- defect).

ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "agent_principal_id" uuid NULL,
  ADD COLUMN "agent_principal_org_id" uuid NULL,
  ADD COLUMN "agent_principal_workspace_id" uuid NULL,
  ADD COLUMN "human_principal_id" uuid NULL,
  ADD COLUMN "human_principal_org_id" uuid NULL,
  ADD COLUMN "human_principal_workspace_id" uuid NULL;
