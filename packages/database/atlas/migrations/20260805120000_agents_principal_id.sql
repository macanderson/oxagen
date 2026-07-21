-- Agent RBAC Phase 1 (docs/specs/agent-rbac/spec.md §2.1, §3.1): every agent
-- IDENTITY gets exactly one delegated iam.principals row (kind='agent',
-- parent_user_id = creating user). This is a SECOND principal that shares the
-- same (org_id, parent_user_id) pair as the creator's own human principal, so
-- the prior "one principal per (org, parent_user)" guard
-- (principals_org_parent_user_uniq, migration 20260802160000) must be
-- narrowed to kind='human' — it was never meant to constrain delegated agent
-- principals, only to dedupe concurrent human-principal provisioning.
--
-- 1. Link each agent identity to its delegated principal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'agent' AND table_name = 'agents' AND column_name = 'principal_id'
  ) THEN
    ALTER TABLE "agent"."agents" ADD COLUMN "principal_id" uuid;
  END IF;
END $$;

COMMENT ON COLUMN "agent"."agents"."principal_id" IS
  'App-enforced reference to iam.principals.id (kind=agent) — the delegated IAM principal for this agent IDENTITY (one per agent, not per version/run). Provisioned at agent.definition.create and soft-deleted together with the agent.';

CREATE INDEX IF NOT EXISTS "agents_principal_idx" ON "agent"."agents" ("principal_id");

-- 2. Narrow the (org_id, parent_user_id) uniqueness guard to kind='human'.
--    Without this, the second (agent-kind) principal insert for the same
--    creating user would violate the index and agent.definition.create would
--    fail on every agent after a user's first one.
DROP INDEX IF EXISTS "iam"."principals_org_parent_user_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "principals_org_parent_user_uniq"
  ON "iam"."principals" ("org_id", "parent_user_id")
  WHERE parent_user_id IS NOT NULL AND kind = 'human';
