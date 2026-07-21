-- agent.agents.principal_id — links an agent identity to its IAM principal
-- (iam.principals kind='agent'), per docs/specs/agent-rbac/spec.md §3.1 /
-- goal #1: "Every non-managed agent has exactly one iam.principals row
-- (kind='agent', parentUserId=creator) created at agent.definition.create
-- and soft-deleted with the agent." One principal per agent IDENTITY, not
-- per version/run — versions change config; identity and role assignments
-- persist across them.
--
-- App-enforced reference (no FK): iam.principals lives in a different Postgres
-- schema, and CLAUDE.md storage rules forbid cross-schema FKs — same
-- convention as file_locks.execution_id / agent_run_events.run_id.
--
-- Hand-written + `atlas migrate hash` (see 20260804100000 module comment —
-- `atlas migrate diff` is broken by the unresolved pg_trgm fresh-replay
-- defect).

ALTER TABLE "agent"."agents"
  ADD COLUMN "principal_id" uuid NULL;

CREATE INDEX "agents_principal_idx"
  ON "agent"."agents" ("principal_id");
