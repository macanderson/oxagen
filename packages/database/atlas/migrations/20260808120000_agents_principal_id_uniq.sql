-- agent.agents.principal_id — tighten the existing plain index into a UNIQUE
-- index AND enforce NOT NULL: every agent identity is created together with
-- its persistent IAM principal in the same transaction
-- (agent.definition.create.ts) and exactly one agent maps to exactly one
-- principal (docs/specs/agent-rbac/spec.md §3.1 — "one principal per agent
-- IDENTITY", never shared across agents, never absent, not per version, not
-- per run). A plain nullable index alone let two agent rows point at the same
-- principal, or an agent exist with no principal at all — either collapses
-- the accountability chain the RBAC wedge depends on.
--
-- No backfill: pre-launch, no customers — final behavior lands directly, per
-- project convention (no transitional/legacy nullable state).
--
-- App-enforced reference (no FK): iam.principals lives in a different
-- Postgres schema, and CLAUDE.md storage rules forbid cross-schema FKs — same
-- convention as the original index (20260805120000_agents_principal_id.sql).
--
-- Hand-written + `atlas migrate hash` (see 20260804100000 module comment —
-- `atlas migrate diff` is broken by the unresolved pg_trgm fresh-replay
-- defect).

ALTER TABLE "agent"."agents"
  ALTER COLUMN "principal_id" SET NOT NULL;

DROP INDEX IF EXISTS "agent"."agents_principal_idx";

CREATE UNIQUE INDEX "agents_principal_idx"
  ON "agent"."agents" ("principal_id");
