-- Arming the loopback model gateway (docs/audits/2026-09-21-model-gateway-arming.md).
--
-- Two changes, both additive:
--
--   1. workspace.tacho_session_policy — the per-workspace setting the signed
--      policy bundle's `budget` and `models` clauses are read from. Until this
--      table existed, `unsignedBundle()` wrote `budget.mode: "observed"` as a
--      literal, so the proxy's `session_budget_exceeded` branch could never
--      fire and the gateway metered without ever refusing anything.
--
--   2. tacho.hosts.model_base_urls — what the daemon reports about the harness
--      config files it wrote the proxy's base URL into. A user who edits that
--      URL back to the vendor leaves the gateway silently, and the only signal
--      the control plane had was a tier that stopped saying `gateway`, with no
--      stated cause.
--
-- Shape and RLS copied from 20260708120000_workspace_budget_policy.sql so a
-- future `atlas migrate diff` sees zero drift.

-- ── Create "tacho_session_policy" table ──────────────────────────────────────
CREATE TABLE "workspace"."tacho_session_policy" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	-- "observed" = meter only (the behaviour every host had before this table);
	-- "enforced" = the proxy refuses a call that breaks the clauses below.
	"mode" text DEFAULT 'observed' NOT NULL,
	-- The per-session ceiling in USD; NULL = no ceiling. numeric, not real:
	-- this feeds a direct comparison against observed spend and float rounding
	-- error is not acceptable for a dollar ceiling (2026-07-11 audit §5 item 1).
	"session_limit_usd" numeric(12,2),
	-- The models the workspace permits. NULL = no allowlist stated, so every
	-- model is permitted; '[]' = an allowlist that permits nothing. The two are
	-- different decisions and must not share an encoding — the same reading
	-- `gateway_tools` carries in the bundle.
	"model_allow" jsonb,
	-- Models refused whatever the allowlist says. Always a list; empty = refuse
	-- none. A deny entry beats an allow entry.
	"model_deny" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tacho_session_policy_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "tacho_session_policy_mode_check" CHECK ("mode" IN ('observed', 'enforced')),
	-- "enforced" with nothing to enforce is the defect this table was added to
	-- fix, wearing a switch. A row may not say it enforces unless it carries at
	-- least one clause the proxy can refuse on.
	CONSTRAINT "tacho_session_policy_enforced_check" CHECK (
		"mode" = 'observed'
		OR "session_limit_usd" IS NOT NULL
		OR "model_allow" IS NOT NULL
		OR jsonb_array_length("model_deny") > 0
	),
	CONSTRAINT "tacho_session_policy_model_allow_check" CHECK (
		"model_allow" IS NULL OR jsonb_typeof("model_allow") = 'array'
	),
	CONSTRAINT "tacho_session_policy_model_deny_check" CHECK (
		jsonb_typeof("model_deny") = 'array'
	)
);
CREATE INDEX "tacho_session_policy_org_workspace_idx" ON "workspace"."tacho_session_policy" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — the `standard` class: org_id + workspace_id both NOT NULL.
--
-- Two policies, not one. `tenant_isolation` scopes every statement to the
-- caller's workspace. `tenant_org_wide_read` is the read widening added by
-- 20260917120000_org_wide_read_mode, which every `standard` table in
-- POLICY_MANIFEST carries: with `app.org_wide = on` an org-scoped reader sees
-- the org's rows across its workspaces, and writes are unaffected because the
-- widening is `FOR SELECT` and adds no WITH CHECK.
--
-- Registering the table as `standard` without the second policy would leave
-- an org-wide read seeing nothing here while it sees every sibling table, and
-- `org-only-sentinel-refusal.test.ts` fails the class for exactly that.
-- Mirrors workspace.workspace_budget_policy.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workspace.tacho_session_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.tacho_session_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.tacho_session_policy;
DROP POLICY IF EXISTS tenant_org_wide_read ON workspace.tacho_session_policy;
CREATE POLICY tenant_isolation ON workspace.tacho_session_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON workspace.tacho_session_policy
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ────────────────────────────────────────────────────────────────────────────
-- tacho.hosts.model_base_urls — the daemon's report on the base URL it wrote
-- into each harness config file: one object per harness with `harness`, `key`,
-- `ours` and, when a managed settings file overrides ours, `shadowed_by`.
-- Empty is the honest default for a row that predates the column and for a
-- daemon too old to report: absent means *not told*, never *not drifted*.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "tacho"."hosts" ADD COLUMN IF NOT EXISTS "model_base_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.tacho_session_policy TO oxagen_app;
  END IF;
END
$$;
