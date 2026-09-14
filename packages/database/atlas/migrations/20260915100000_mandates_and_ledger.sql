-- ADR-059 (G2957): mandates — bounded, expiring authority for a consequence,
-- with a ledger the accountable office reads (MC spec §6.9 part 3, App. A.5).
--
-- Hand-written from the drizzle schema (packages/database/src/schema/tools.ts,
-- agent.ts, workspace.ts) and reviewed; the statements below are this
-- change's only.
--
--   1. The `tools` schema, `tools.mandates` and the append-only
--      `tools.mandate_ledger`, with tenant + workspace RLS (the policy text is
--      what tools/scripts/gen-rls-migration.ts emits for class `standard`) and
--      oxagen_app grants: the ledger takes SELECT and INSERT only.
--   2. agent.approval_requests gains the four-hop chain columns the mandate
--      gate writes when a call parks for a person: mandate_id, rule_ids,
--      input_digest, token_used_at (ADR-059 decision 4).
--   3. agent.tool_versions gains the safety classification the gate reads:
--      consequence_tags, measures, effect_id_path (ADR-059 decision 6).
--   4. workspace.workspaces gains consequence_roles, the tag → role overrides
--      (ADR-059 decision 1).
--
-- Two-person columns (two_person, second_approver) are not created: the
-- scope note of 2026-09-14 cuts two-person mandates from this release.

-- ── 1. tools.mandates and tools.mandate_ledger ──────────────────────────────
CREATE SCHEMA IF NOT EXISTS "tools";

CREATE TABLE "tools"."mandates" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "agent_principal_id" uuid NOT NULL,
  "requested_by" uuid NULL,
  "granted_by" uuid NULL,
  "role_at_grant" text NULL,
  "consequence_tags" text[] NOT NULL,
  "limits" jsonb NOT NULL,
  "targets" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "tools" text[] NOT NULL,
  "approval_rules" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "purpose" text NOT NULL,
  "valid_from" timestamptz NOT NULL,
  "valid_to" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "revoked_by" uuid NULL,
  "revoked_reason" text NULL,
  "revoked_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "mandates_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "mandates_status_check" CHECK ("status" IN ('draft', 'active', 'expired', 'revoked')),
  CONSTRAINT "mandates_validity_check" CHECK ("valid_to" > "valid_from"),
  CONSTRAINT "mandates_grant_check" CHECK (("status" = 'draft') OR ("granted_by" IS NOT NULL AND "role_at_grant" IS NOT NULL))
);
CREATE INDEX "mandates_agent_status_idx" ON "tools"."mandates" ("org_id", "workspace_id", "agent_principal_id", "status");
CREATE INDEX "mandates_status_valid_to_idx" ON "tools"."mandates" ("status", "valid_to");
CREATE INDEX "mandates_org_idx" ON "tools"."mandates" ("org_id", "workspace_id");

COMMENT ON TABLE "tools"."mandates" IS
  'Bounded, expiring authority for a consequence, granted to one agent principal within limits over declared measures (MC spec §6.9 part 3, ADR-059).';
COMMENT ON COLUMN "tools"."mandates"."limits" IS
  'measure → { perCall?, perPeriod?, period, currencyOrUnit }; integer strings: micros for a currency, whole units otherwise.';
COMMENT ON COLUMN "tools"."mandates"."targets" IS
  'measure → { allow: glob[], deny: glob[] } over a text measure read from the call.';
COMMENT ON COLUMN "tools"."mandates"."tools" IS
  'Glob patterns over slug@version (or slug) of declared tools in agent.tools.';
COMMENT ON COLUMN "tools"."mandates"."approval_rules" IS
  '{ humanAbove: { measure: value }, alwaysHumanFor: tag[], approvers: string[] }: the mandate''s own approval rule.';

CREATE TABLE "tools"."mandate_ledger" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "mandate_id" uuid NOT NULL,
  "tool_call_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "measure" text NOT NULL,
  "value" numeric NOT NULL,
  "unit_or_currency" text NOT NULL,
  "external_effect_id" text NULL,
  "period_key" text NOT NULL,
  "balance_after" numeric NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "mandate_ledger_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "tools"."mandates" ("id"),
  CONSTRAINT "mandate_ledger_kind_check" CHECK ("kind" IN ('reserve', 'settle', 'release')),
  CONSTRAINT "mandate_ledger_value_check" CHECK ("value" >= 0)
);
CREATE UNIQUE INDEX "mandate_ledger_movement_uniq" ON "tools"."mandate_ledger" ("mandate_id", "tool_call_id", "measure", "kind");
CREATE INDEX "mandate_ledger_balance_idx" ON "tools"."mandate_ledger" ("mandate_id", "measure", "period_key", "created_at");
CREATE INDEX "mandate_ledger_call_idx" ON "tools"."mandate_ledger" ("tool_call_id");
CREATE INDEX "mandate_ledger_org_idx" ON "tools"."mandate_ledger" ("org_id", "workspace_id");

COMMENT ON TABLE "tools"."mandate_ledger" IS
  'Append-only movements on a mandate''s remaining authority, one row per measure: reserve at decision time, settle at receipt time, release on failure or denial. balance_after is the remaining authority after the row (ADR-059 decision 5).';
COMMENT ON COLUMN "tools"."mandate_ledger"."tool_call_id" IS
  'The call the movement belongs to; minted by the gate per decision and carried on the approval row that parks the call.';
COMMENT ON COLUMN "tools"."mandate_ledger"."external_effect_id" IS
  'The transaction, migration, message or deployment id the tool returned; settle rows only.';
COMMENT ON COLUMN "tools"."mandate_ledger"."period_key" IS
  'YYYY-MM-DD, YYYY-Www or YYYY-MM in UTC, by the limit''s period.';

-- Tenant + workspace RLS, class `standard` (tools/scripts/gen-rls-migration.ts).
ALTER TABLE tools.mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools.mandates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tools.mandates;
CREATE POLICY tenant_isolation ON tools.mandates
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tools.mandate_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools.mandate_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tools.mandate_ledger;
CREATE POLICY tenant_isolation ON tools.mandate_ledger
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- oxagen_app grants: guarded, fresh clusters may lack the role. The ledger is
-- append-only at the grant level — no UPDATE, no DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA tools TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tools.mandates TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON tools.mandate_ledger TO oxagen_app';
  END IF;
END
$$;

-- ── 2. The four-hop chain on approval requests ──────────────────────────────
ALTER TABLE "agent"."approval_requests"
  ADD COLUMN "mandate_id" uuid NULL,
  ADD COLUMN "rule_ids" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN "input_digest" text NULL,
  ADD COLUMN "token_used_at" timestamptz NULL;

CREATE INDEX "approval_requests_mandate_digest_idx"
  ON "agent"."approval_requests" ("workspace_id", "mandate_id", "input_digest")
  WHERE mandate_id IS NOT NULL;

COMMENT ON COLUMN "agent"."approval_requests"."mandate_id" IS
  'The mandate the parked call drew on (tools.mandates, app-enforced); null on the chat approval gate''s rows.';
COMMENT ON COLUMN "agent"."approval_requests"."rule_ids" IS
  'The rule ids that required a person: mandate:<public_id>:human_above:<measure> or mandate:<public_id>:always_human_for:<tag>.';
COMMENT ON COLUMN "agent"."approval_requests"."input_digest" IS
  'sha256 hex of the call''s canonical input; the retry of an approved call matches on it.';
COMMENT ON COLUMN "agent"."approval_requests"."token_used_at" IS
  'When the approved call was retried and proceeded on this approval; an approval is single-use.';

-- ── 3. Safety classification on tool versions ───────────────────────────────
ALTER TABLE "agent"."tool_versions"
  ADD COLUMN "consequence_tags" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN "measures" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "effect_id_path" text NULL;

COMMENT ON COLUMN "agent"."tool_versions"."consequence_tags" IS
  'The consequences invoking this version can cause (MC spec §6.9 part 1): moves_money, destroys_data, alters_production, communicates_externally, changes_access, changes_entitlement, or a customer-defined tag.';
COMMENT ON COLUMN "agent"."tool_versions"."measures" IS
  'measure name → { path, type: amount | count | text, unit, scale? }: how the gate reads each measure from the call''s input.';
COMMENT ON COLUMN "agent"."tool_versions"."effect_id_path" IS
  'Dot path into the tool''s output carrying the external effect id a settlement records.';

-- ── 4. Consequence roles on the workspace ───────────────────────────────────
ALTER TABLE "workspace"."workspaces"
  ADD COLUMN "consequence_roles" jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN "workspace"."workspaces"."consequence_roles" IS
  'Consequence tag → IAM org role names that may grant, change or revoke a mandate for it; overrides over DEFAULT_CONSEQUENCE_ROLES (ADR-059 decision 1).';
