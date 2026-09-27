-- The no-progress limit (spend spec, detector 1; #4490).
--
-- Two tables, both new:
--
--   1. workspace.no_progress_policy: the limit the owning team sets for its
--      runs, as a count of calls in a row and a mode. No row, or a NULL
--      count, means no check. The limit ships with no default count.
--
--   2. cost.no_progress_hits: one row per loop that reached the limit. A loop
--      is the same call, with the same tool, input digest, and output digest,
--      made again and again in a row. `cost.run-progress` writes a loop's row
--      once and later passes only raise `repeats` as the loop grows.
--
-- Shape mirrors the drizzle schema (packages/database/src/schema/workspace.ts
-- `noProgressPolicy`, packages/database/src/schema/cost.ts `noProgressHits`).
-- RLS and grants are copied from 20260922130000_tacho_session_policy.sql.

-- ── Create "no_progress_policy" table ────────────────────────────────────────
CREATE TABLE "workspace"."no_progress_policy" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	-- The calls in a row that make a hit, the first one included. NULL = no
	-- limit set, so no check runs.
	"repeats" integer,
	-- "observe" = record each hit and let the run continue; "enforced" = also
	-- pause the run at the next checkpoint, on governed calls.
	"mode" text DEFAULT 'observe' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "no_progress_policy_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "no_progress_policy_mode_check" CHECK ("mode" IN ('observe', 'enforced')),
	-- One call and one repeat of it is the smallest loop there is.
	CONSTRAINT "no_progress_policy_repeats_check" CHECK ("repeats" IS NULL OR "repeats" >= 2)
);
CREATE INDEX "no_progress_policy_org_workspace_idx" ON "workspace"."no_progress_policy" USING btree ("org_id","workspace_id");

-- ── Create "no_progress_hits" table ──────────────────────────────────────────
CREATE TABLE "cost"."no_progress_hits" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	-- The run's public id: `arun_…` (evidence ledger) or `tse_…` (tacho).
	"run_id" text NOT NULL,
	"tool" text NOT NULL,
	"input_digest" text NOT NULL,
	"output_digest" text NOT NULL,
	-- 1 for the call's first loop in the run, 2 for its second.
	"loop" integer NOT NULL,
	-- The calls in the loop so far, the first one included.
	"repeats" integer NOT NULL,
	-- The limit the loop reached.
	"limit_repeats" integer NOT NULL,
	-- The call that reached the limit, counted from 1 in the run's call order.
	"at_call" integer NOT NULL,
	-- The mode and outcome in force when the loop reached the limit.
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "no_progress_hits_mode_check" CHECK ("mode" IN ('observe','enforced')),
	CONSTRAINT "no_progress_hits_outcome_check" CHECK ("outcome" IN ('would_pause','paused')),
	-- Only an enforced limit pauses a run.
	CONSTRAINT "no_progress_hits_paused_check" CHECK ("outcome" = 'would_pause' OR "mode" = 'enforced'),
	CONSTRAINT "no_progress_hits_loop_check" CHECK ("loop" >= 1),
	CONSTRAINT "no_progress_hits_repeats_check" CHECK ("limit_repeats" >= 2 AND "repeats" >= "limit_repeats"),
	CONSTRAINT "no_progress_hits_at_call_check" CHECK ("at_call" >= "limit_repeats")
);
CREATE UNIQUE INDEX "no_progress_hits_loop_idx" ON "cost"."no_progress_hits" USING btree ("workspace_id","run_id","tool","input_digest","output_digest","loop");
CREATE INDEX "no_progress_hits_org_workspace_idx" ON "cost"."no_progress_hits" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS for the `standard` class: org_id and workspace_id both NOT NULL.
--
-- `tenant_isolation` scopes every statement to the caller's workspace.
-- `tenant_org_wide_read` is the read widening every `standard` table in
-- POLICY_MANIFEST carries (20260917120000_org_wide_read_mode). The check
-- runs on the system connection with explicit org and workspace predicates.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workspace.no_progress_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.no_progress_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.no_progress_policy;
DROP POLICY IF EXISTS tenant_org_wide_read ON workspace.no_progress_policy;
CREATE POLICY tenant_isolation ON workspace.no_progress_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON workspace.no_progress_policy
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE cost.no_progress_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost.no_progress_hits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cost.no_progress_hits;
DROP POLICY IF EXISTS tenant_org_wide_read ON cost.no_progress_hits;
CREATE POLICY tenant_isolation ON cost.no_progress_hits
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON cost.no_progress_hits
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants, guarded because a fresh cluster may lack
-- the role.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.no_progress_policy TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON cost.no_progress_hits TO oxagen_app;
  END IF;
END
$$;
