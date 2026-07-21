-- Scope principals_org_parent_user_uniq to kind='human' (docs/specs/agent-rbac
-- /spec.md §3.1). The prior index (20260802160000) was UNIQUE(org_id,
-- parent_user_id) WHERE parent_user_id IS NOT NULL — correct when the ONLY
-- principals carrying parent_user_id were humans (and API-key-delegated
-- humans). Agent RBAC now provisions one iam.principals row per agent
-- IDENTITY with parentUserId=creator too (agent.definition.create.ts), so a
-- user creating ANY agent collided with their own human principal on
-- (org_id, parent_user_id) — the agent-principal INSERT unique-violated
-- against the human row created at org bootstrap (iam-provision.ts).
--
-- Fix: the uniqueness guarantee only ever needed to cover "the human's own
-- principal per org" (fetch-authz.ts's WHERE org_id=? AND parent_user_id=?
-- LIMIT 1 resolution path for humans/API keys). Re-scope to kind='human' so a
-- user may hold at most one human principal per org (unchanged guarantee)
-- while owning arbitrarily many agent principals (parentUserId=same user,
-- kind='agent') in the same org, each on its own row.
--
-- No backfill needed: production has 0 agent principals today (this ships
-- alongside their first provisioning path), so there is nothing to
-- deduplicate — this is a pure index swap.
--
-- Hand-written + `atlas migrate hash` (see 20260804100000 module comment —
-- `atlas migrate diff` is broken by the unresolved pg_trgm fresh-replay
-- defect).

DROP INDEX IF EXISTS "iam"."principals_org_parent_user_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "principals_org_parent_user_human_uniq"
  ON "iam"."principals" ("org_id", "parent_user_id")
  WHERE parent_user_id IS NOT NULL AND kind = 'human';
