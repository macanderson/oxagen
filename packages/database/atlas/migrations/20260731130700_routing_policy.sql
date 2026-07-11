-- workspace.routing_policy — Verified-Outcome Market Router GOVERNANCE. An
-- org/workspace admin decides whether model routing is learned+economic (market)
-- or the deterministic default, plus the tunables (verified-success bar, min
-- samples, window, tier-escalation on judge rejection). ONE table holds both
-- scopes: a row with workspace_id = NULL is the ORG-LEVEL default for every
-- workspace; a row with a workspace_id overrides it for that workspace. Resolved
-- by resolveEffectiveRoutingPolicy in @oxagen/agent-engine (workspace > org >
-- OFF-default). Off by default — absent rows ⇒ today's deterministic routing.
--
-- Backs get_routing_policy / set_routing_policy. RLS class `workspace_nullable`
-- (org_id NOT NULL, workspace_id NULLABLE) — mirrors security.security_events /
-- iam.principals so a withTenantDb read sees BOTH the org-default row and the
-- workspace's own row. Additive.

-- ── Create "routing_policy" table ────────────────────────────────────────────
CREATE TABLE "workspace"."routing_policy" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"mode" text DEFAULT 'off' NOT NULL,
	"success_threshold" real DEFAULT 0.95 NOT NULL,
	"min_samples" integer DEFAULT 20 NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL,
	"escalate_on_rejection" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- At most one org-level default row per org (workspace_id IS NULL)…
CREATE UNIQUE INDEX "routing_policy_org_default_idx" ON "workspace"."routing_policy" USING btree ("org_id") WHERE workspace_id IS NULL;
-- …and at most one row per workspace.
CREATE UNIQUE INDEX "routing_policy_workspace_idx" ON "workspace"."routing_policy" USING btree ("workspace_id") WHERE workspace_id IS NOT NULL;
CREATE INDEX "routing_policy_org_workspace_idx" ON "workspace"."routing_policy" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — workspace_nullable (org_id NOT NULL, workspace_id nullable). A NULL
-- workspace_id row is the org-level default, visible to (and writable by) every
-- workspace in the org; a non-NULL row is that workspace's own policy. Mirrors
-- the predicate tools/scripts/gen-rls-migration.ts emits for `workspace_nullable`.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workspace.routing_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.routing_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.routing_policy;
CREATE POLICY tenant_isolation ON workspace.routing_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.routing_policy TO oxagen_app;
  END IF;
END
$$;
