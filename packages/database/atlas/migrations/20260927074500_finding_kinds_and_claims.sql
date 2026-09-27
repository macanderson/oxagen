-- ADR-206: the unproductive spend contract.
--
-- Written by hand against the drizzle schema (packages/database/src/schema/cost.ts,
-- `findings` and `findingClaims`) in the shape `atlas migrate diff` emits.
--
-- cost.findings gains eight kinds. The four existing kinds stay, including
-- unpaged_results.
--
-- cost.finding_claims holds the model calls each whole-call finding priced.
-- The headline unproductive spend adds claims from detectors 1, 7, and 8, and
-- counts a call once, under the lowest detector that claims it. Detectors 2,
-- 3, 4, and 5 price part of a call and write no claim.
--
-- The RLS below matches what tools/scripts/gen-rls-migration.ts emits for a
-- standard manifest table. It lives in this file so the change is one migration.

-- Modify "findings" table
ALTER TABLE "cost"."findings" DROP CONSTRAINT "findings_kind_check", ADD CONSTRAINT "findings_kind_check" CHECK (kind = ANY (ARRAY['cache_writes_never_read'::text, 'duplicate_tool_calls'::text, 'repeated_shell_commands'::text, 'unpaged_results'::text, 'spin_loops'::text, 'standing_context'::text, 'idle_cache_rewrites'::text, 'cache_busts'::text, 'model_class_fit'::text, 'repeated_instructions'::text, 'recurring_runs'::text, 'spend_with_no_outcome'::text]));

-- Create "finding_claims" table
CREATE TABLE "cost"."finding_claims" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "finding_id" uuid NOT NULL,
  "detector" smallint NOT NULL,
  "run_id" text NOT NULL,
  "frame_key" text NOT NULL,
  "frame_at" timestamptz NOT NULL,
  "operator_key" text NULL,
  "cost_micros" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  PRIMARY KEY ("id"),
  CONSTRAINT "finding_claims_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "cost"."findings" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "finding_claims_cost_check" CHECK (cost_micros >= 0),
  CONSTRAINT "finding_claims_detector_check" CHECK (detector = ANY (ARRAY[1, 7, 8]))
);
-- Create index "finding_claims_finding_frame_idx" to table: "finding_claims"
CREATE UNIQUE INDEX "finding_claims_finding_frame_idx" ON "cost"."finding_claims" ("finding_id", "run_id", "frame_key");
-- Create index "finding_claims_workspace_frame_at_idx" to table: "finding_claims"
CREATE INDEX "finding_claims_workspace_frame_at_idx" ON "cost"."finding_claims" ("workspace_id", "frame_at");

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE cost.finding_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost.finding_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cost.finding_claims;
DROP POLICY IF EXISTS tenant_org_wide_read ON cost.finding_claims;
CREATE POLICY tenant_isolation ON cost.finding_claims
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON cost.finding_claims
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ── Grants ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON cost.finding_claims TO oxagen_app';
  END IF;
END
$$;
