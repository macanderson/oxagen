-- billing.spend_budgets — hard PERIOD-TO-DATE spend ceiling (OXA-1079). A
-- distinct axis from the per-TURN dollar budget (workspace.workspace_budget_policy
-- / budget.policy.*): this ceiling caps cumulative period spend for a whole org or
-- workspace and is enforced in the kernel invoke() admission path (the budget gate,
-- next to IAM/billing) so a runaway fleet is DENIED before the provider call.
--
-- ONE table holds both scopes (mirrors workspace.routing_policy): a row with
-- workspace_id = NULL is the ORG-LEVEL ceiling for all workspace spend; a
-- non-NULL workspace_id scopes it to that one workspace. Both apply — the gate
-- denies when EITHER is exceeded.
--
-- Backs get_spend_budget / set_spend_budget. RLS class `workspace_nullable`
-- (org_id NOT NULL, workspace_id NULLABLE) — mirrors workspace.routing_policy so
-- a withTenantDb read sees BOTH the org-default row and the workspace's own row.
-- Additive.

-- ── Create "spend_budgets" table ─────────────────────────────────────────────
CREATE TABLE "billing"."spend_budgets" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"public_id" citext NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"period" text DEFAULT 'monthly' NOT NULL,
	"window_days" integer,
	"limit_micros" bigint NOT NULL,
	"notified_threshold" integer DEFAULT 0 NOT NULL,
	"notified_period_start" timestamp with time zone,
	CONSTRAINT "spend_budgets_period_check" CHECK ("period" IN ('monthly','rolling')),
	CONSTRAINT "spend_budgets_window_check" CHECK (("period" = 'rolling' AND "window_days" IS NOT NULL AND "window_days" > 0) OR ("period" = 'monthly' AND "window_days" IS NULL)),
	CONSTRAINT "spend_budgets_limit_check" CHECK ("limit_micros" > 0)
);
CREATE UNIQUE INDEX "spend_budgets_public_id_key" ON "billing"."spend_budgets" USING btree ("public_id");
-- At most one org-level ceiling per org (workspace_id IS NULL)…
CREATE UNIQUE INDEX "spend_budgets_org_default_idx" ON "billing"."spend_budgets" USING btree ("org_id") WHERE workspace_id IS NULL;
-- …and at most one ceiling per workspace.
CREATE UNIQUE INDEX "spend_budgets_workspace_idx" ON "billing"."spend_budgets" USING btree ("workspace_id") WHERE workspace_id IS NOT NULL;
CREATE INDEX "spend_budgets_org_workspace_idx" ON "billing"."spend_budgets" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — workspace_nullable (org_id NOT NULL, workspace_id nullable). A NULL
-- workspace_id row is the org-level ceiling, visible to (and writable by) every
-- workspace in the org; a non-NULL row is that workspace's own ceiling. Mirrors
-- the predicate tools/scripts/gen-rls-migration.ts emits for `workspace_nullable`.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE billing.spend_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.spend_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.spend_budgets;
CREATE POLICY tenant_isolation ON billing.spend_budgets
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON billing.spend_budgets TO oxagen_app;
  END IF;
END
$$;
