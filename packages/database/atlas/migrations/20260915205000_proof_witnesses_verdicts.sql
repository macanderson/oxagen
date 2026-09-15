-- Proof: witnesses, verdicts and the workspace disclosure grain (Mission
-- Control spec §8.5, ADR-064, #2955). Expand-only: three new tables and a
-- widened security-event CHECK. Grants to oxagen_app: SELECT and INSERT on
-- evidence.witnesses and evidence.verdicts (records, never rewritten), SELECT,
-- INSERT and UPDATE on evidence.disclosure_policies.
--
--   1. evidence.witnesses: one row per witness a workspace has a verdict for;
--      its oracle kind, command digest and held-out flag are immutable.
--   2. evidence.verdicts: one row per `proof.observed` frame, written by
--      ingest_tacho_events under the root session's run; a frame is named by
--      the session whose chain carried it and its seq there. The CHECKs mirror the body schema in
--      @oxagen/run-evidence (a flip is a fail on the target and a pass on the
--      head; a broken fingerprint is exactly `tampered`).
--   3. evidence.disclosure_policies: the grain a workspace discloses to its
--      workers; no row is L0.
--   4. Tenant isolation for all three in the manifest's shape
--      (tools/scripts/gen-rls-migration.ts, policy class `standard`).
--   5. security.security_events admits evidence.disclosure_grain_changed.
--
-- cost.run_totals already carries verdict, accepted and productive_ratio
-- (20260914 ADR-060 migration); the rollup fills verdict from these rows.

-- ── 1. evidence.witnesses ────────────────────────────────────────────────────
CREATE TABLE "evidence"."witnesses" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "witness_id" text NOT NULL,
  "oracle_kind" text NOT NULL,
  "command_digest" text NOT NULL,
  "held_out" boolean NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "witnesses_oracle_kind_check" CHECK ("oracle_kind" IN ('test_flip', 'build_or_type', 'property', 'golden_snapshot', 'contract', 'metamorphic', 'behavioral_probe')),
  CONSTRAINT "witnesses_command_digest_check" CHECK ("command_digest" ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "witnesses_witness_uniq"
  ON "evidence"."witnesses" ("org_id", "workspace_id", "witness_id");

-- ── 2. evidence.verdicts ─────────────────────────────────────────────────────
CREATE TABLE "evidence"."verdicts" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "run_id" text NOT NULL,
  "session_uuid" uuid NOT NULL,
  "frame_seq" bigint NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "witness_id" text NOT NULL,
  "attempt_no" integer NOT NULL,
  "witness_run_id" text NULL,
  "target_ref" text NOT NULL,
  "target_sha" text NOT NULL,
  "pr_ref" text NOT NULL,
  "pr_sha" text NOT NULL,
  "target_result" text NOT NULL,
  "pr_result" text NOT NULL,
  "verdict" text NOT NULL,
  "fail_fingerprint" text NULL,
  "pass_output_digest" text NULL,
  "tamper_exclusion" text NOT NULL,
  "tamper" jsonb NULL,
  "disclosure_grain" text NOT NULL,
  "runner_attestation" jsonb NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "verdicts_witness_fk" FOREIGN KEY ("org_id", "workspace_id", "witness_id")
    REFERENCES "evidence"."witnesses" ("org_id", "workspace_id", "witness_id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "verdicts_verdict_check" CHECK ("verdict" IN ('flipped', 'failing', 'unmoved', 'unsatisfied', 'tampered', 'unverified', 'waived')),
  CONSTRAINT "verdicts_result_check" CHECK ("target_result" IN ('pass', 'fail', 'excluded', 'inconclusive') AND "pr_result" IN ('pass', 'fail', 'excluded', 'inconclusive')),
  CONSTRAINT "verdicts_disclosure_grain_check" CHECK ("disclosure_grain" IN ('L0', 'L1', 'L2', 'L3')),
  CONSTRAINT "verdicts_tamper_check" CHECK ("tamper_exclusion" IN ('held', 'broken') AND ("tamper_exclusion" = 'broken') = ("verdict" = 'tampered') AND ("tamper" IS NOT NULL) = ("tamper_exclusion" = 'broken')),
  CONSTRAINT "verdicts_flip_check" CHECK ("verdict" <> 'flipped' OR ("target_result" = 'fail' AND "pr_result" = 'pass')),
  CONSTRAINT "verdicts_attempt_check" CHECK ("attempt_no" > 0)
);
CREATE UNIQUE INDEX "verdicts_frame_uniq"
  ON "evidence"."verdicts" ("org_id", "workspace_id", "run_id", "session_uuid", "frame_seq");
CREATE UNIQUE INDEX "verdicts_attempt_uniq"
  ON "evidence"."verdicts" ("org_id", "workspace_id", "run_id", "witness_id", "attempt_no");
CREATE INDEX "verdicts_witness_run_idx"
  ON "evidence"."verdicts" ("org_id", "workspace_id", "witness_run_id");

-- ── 3. evidence.disclosure_policies ──────────────────────────────────────────
CREATE TABLE "evidence"."disclosure_policies" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "grain" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "disclosure_policies_grain_check" CHECK ("grain" IN ('L0', 'L1', 'L2', 'L3'))
);
CREATE UNIQUE INDEX "disclosure_policies_workspace_uniq"
  ON "evidence"."disclosure_policies" ("org_id", "workspace_id");

-- ── 4. Tenant isolation ──────────────────────────────────────────────────────
ALTER TABLE evidence.witnesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.witnesses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence.witnesses;
CREATE POLICY tenant_isolation ON evidence.witnesses
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE evidence.verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.verdicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence.verdicts;
CREATE POLICY tenant_isolation ON evidence.verdicts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE evidence.disclosure_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.disclosure_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence.disclosure_policies;
CREATE POLICY tenant_isolation ON evidence.disclosure_policies
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON evidence.witnesses TO oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON evidence.witnesses FROM oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON evidence.verdicts TO oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON evidence.verdicts FROM oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON evidence.disclosure_policies TO oxagen_app';
    EXECUTE 'REVOKE DELETE ON evidence.disclosure_policies FROM oxagen_app';
  END IF;
END
$$;

-- ── 5. The security event the grain writes ───────────────────────────────────
-- The event_type CHECK is a shared cell: every migration that touches it DROPs
-- and re-ADDs the whole constraint, and security-event-types.test.ts holds the
-- latest one byte-identical to generateEventTypeCheckClause()
-- (packages/compliance/src/db-check.ts). The list below was generated from the
-- taxonomy over the tree this file merges onto, so it keeps every value
-- 20260915160000 added (steering.published) and adds
-- evidence.disclosure_grain_changed. Additive, so no NOT VALID.
ALTER TABLE "security"."security_events" DROP CONSTRAINT IF EXISTS "security_events_event_type_check";
ALTER TABLE "security"."security_events" ADD CONSTRAINT "security_events_event_type_check"
  CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published'));
