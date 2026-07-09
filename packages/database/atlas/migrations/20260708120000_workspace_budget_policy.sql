-- OXA-2081: workspace.workspace_budget_policy — per-workspace per-turn dollar
-- budget GOVERNANCE. An org/workspace admin sets a budget for a workspace: a
-- soft `default` (seeds members who haven't set their own) or a hard `ceiling`
-- (clamps members — they can't exceed it, and the enforcement mode can only get
-- stricter). Resolved against the member's own budget by resolveEffectiveTurnBudget
-- in @oxagen/billing; the shared runCodingAgent guard enforces the merged policy.
--
-- Backs workspace.budget.policy.read / workspace.budget.policy.write. Standard
-- tenant-owned-table shape + RLS (org_id + workspace_id both NOT NULL), copied
-- from 20260628130000_add_workspace_memory_policy.sql so a future
-- `atlas migrate diff` sees zero drift. Additive: absent rows ⇒ no governance.

-- ── Create "workspace_budget_policy" table ───────────────────────────────────
CREATE TABLE "workspace"."workspace_budget_policy" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_usd" real,
	"mode" text DEFAULT 'enforce' NOT NULL,
	"grace_overage_pct" real DEFAULT 0.25 NOT NULL,
	"enforcement" text DEFAULT 'ceiling' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_budget_policy_workspace_id_unique" UNIQUE("workspace_id")
);
CREATE UNIQUE INDEX "workspace_budget_policy_workspace_idx" ON "workspace"."workspace_budget_policy" USING btree ("workspace_id");
CREATE INDEX "workspace_budget_policy_org_workspace_idx" ON "workspace"."workspace_budget_policy" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — standard tenant_isolation (org_id + workspace_id both NOT NULL).
-- Mirrors workspace.workspace_memory_policy (20260628130000).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workspace.workspace_budget_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspace_budget_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.workspace_budget_policy;
CREATE POLICY tenant_isolation ON workspace.workspace_budget_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.workspace_budget_policy TO oxagen_app;
  END IF;
END
$$;
