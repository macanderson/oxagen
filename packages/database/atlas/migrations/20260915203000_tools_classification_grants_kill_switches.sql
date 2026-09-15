-- ADR-065 (G2958): the tool registry's safety classification, the credential
-- broker's grant log, and kill switches on iam.emergency_denies.
--
-- Hand-written from the drizzle schema (packages/database/src/schema/agent.ts,
-- mcp.ts, iam.ts) in the style of `pnpm db:migrate:diff` output.
--
--   1. agent.tools gains mcp_server_id: the mcp.mcp_servers row an imported
--      tool came from (null for a declared tool). Not a foreign key: a server
--      soft-deletes and its tools keep their rows for replay.
--   2. agent.tool_versions gains schema_origin (declared | imported; the
--      observed origins arrive with the recorder that captures tool outputs),
--      the classification jsonb (side-effect class, egress class, consequence
--      tags, measures, data classes — spec §6.9 part 1), the risk grade the
--      classifier set (classified_risk_grade; risk_grade stays the declared
--      grade the version's checksum covers) and who set it, when and why.
--      Every existing version is a declared one. A changed classification
--      bumps the deny generation in the same transaction, because it changes
--      which class kill switches reach the version (trigger below).
--   3. mcp.mcp_servers gains last_import_at / last_import_digest, stamped by
--      import_tools.
--   4. mcp.credential_grants: one row per credential the broker put to use for
--      a tool server on behalf of a run (spec §6.8, App. A.5). RLS for it is
--      in 20260915203100_rls_credential_grants.sql (generated from the tenant
--      policy manifest).
--   5. iam.emergency_denies gains target_kind, target_id and flipped_by_user_id
--      so a deny written by set_kill_switch names what it stops, and one
--      active row per target, and cleared_reason for why a switch was flipped
--      off. reason, active and deactivated_at are reused (spec §6.11). The existing AFTER trigger on this table bumps the deny
--      generation in the same transaction as the write (20260813110000).

-- ── 1. agent.tools: the server an imported tool came from ─────────────────────
ALTER TABLE "agent"."tools"
  ADD COLUMN "mcp_server_id" uuid NULL;
CREATE INDEX "tools_mcp_server_idx" ON "agent"."tools" ("mcp_server_id")
  WHERE (mcp_server_id IS NOT NULL);

-- ── 2. agent.tool_versions: schema origin and classification ─────────────────
ALTER TABLE "agent"."tool_versions"
  ADD COLUMN "schema_origin" text NOT NULL DEFAULT 'declared',
  ADD COLUMN "classification" jsonb NULL,
  ADD COLUMN "classified_by_user_id" uuid NULL,
  ADD COLUMN "classified_at" timestamptz NULL,
  ADD COLUMN "classification_reason" text NULL,
  ADD COLUMN "classified_risk_grade" text NULL,
  ADD CONSTRAINT "tool_versions_schema_origin_check"
    CHECK (schema_origin IN ('declared', 'imported')),
  ADD CONSTRAINT "tool_versions_classified_risk_grade_check"
    CHECK (classified_risk_grade IS NULL OR classified_risk_grade IN ('low', 'medium', 'high', 'critical')),
  ADD CONSTRAINT "tool_versions_classification_check"
    CHECK ((classification IS NULL AND classified_at IS NULL AND classified_risk_grade IS NULL)
        OR (classification IS NOT NULL AND classified_at IS NOT NULL AND classified_risk_grade IS NOT NULL));
-- The gateway's kill-switch gate reloads the classification index only when
-- the deny generation moves, so a classification change bumps it the way an
-- emergency deny does: in the writer's transaction, through the same
-- security-definer trigger function (20260813110000). A publish that carries
-- the classification onto a new version changes no tag and bumps nothing.
CREATE TRIGGER "tool_versions_classification_deny_generation"
  AFTER UPDATE OF "classification" ON "agent"."tool_versions"
  FOR EACH ROW
  WHEN (OLD.classification IS DISTINCT FROM NEW.classification)
  EXECUTE FUNCTION "iam"."deny_generation_scoped_trigger"();

-- ── 3. mcp.mcp_servers: the last import ──────────────────────────────────────
ALTER TABLE "mcp"."mcp_servers"
  ADD COLUMN "last_import_at" timestamptz NULL,
  ADD COLUMN "last_import_digest" text NULL,
  ADD CONSTRAINT "mcp_servers_last_import_check"
    CHECK ((last_import_at IS NULL) = (last_import_digest IS NULL));

-- ── 4. mcp.credential_grants: the broker's log ───────────────────────────────
CREATE TABLE "mcp"."credential_grants" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  -- The connection's public id at mint time; a revoked connection's row is
  -- deleted and the log keeps naming it.
  "connection_public_id" citext NOT NULL,
  "mcp_server_id" uuid NOT NULL,
  "run_id" text NULL,
  "scope" jsonb NOT NULL,
  "provider_token_id" text NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "credential_grants_public_id_unique" UNIQUE ("public_id"),
  -- TTL defaults to the call's expected duration plus a margin and is never
  -- more than one hour (spec §6.8).
  CONSTRAINT "credential_grants_ttl_check"
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '1 hour')
);
CREATE INDEX "credential_grants_org_idx" ON "mcp"."credential_grants" ("org_id", "workspace_id");
CREATE INDEX "credential_grants_issued_idx" ON "mcp"."credential_grants" ("workspace_id", "issued_at");
CREATE INDEX "credential_grants_connection_live_idx" ON "mcp"."credential_grants" ("connection_id")
  WHERE (revoked_at IS NULL);

-- ── 5. iam.emergency_denies: what a kill switch stops ────────────────────────
ALTER TABLE "iam"."emergency_denies"
  ADD COLUMN "target_kind" text NULL,
  ADD COLUMN "target_id" text NULL,
  ADD COLUMN "flipped_by_user_id" uuid NULL,
  ADD COLUMN "cleared_reason" text NULL,
  ADD CONSTRAINT "emergency_denies_target_kind_check"
    CHECK (target_kind IS NULL OR target_kind IN ('tool_version', 'tool_server', 'connection', 'agent', 'operator', 'workspace', 'org', 'class')),
  ADD CONSTRAINT "emergency_denies_target_check"
    CHECK ((target_kind IS NULL) = (target_id IS NULL)),
  -- A kill switch flipped off says why; a row with no target is written by
  -- another path and is not held to it.
  ADD CONSTRAINT "emergency_denies_cleared_reason_check"
    CHECK (target_kind IS NULL OR active = true OR cleared_reason IS NOT NULL);
CREATE INDEX "emergency_denies_switch_idx" ON "iam"."emergency_denies" ("org_id", "activated_at")
  WHERE (target_kind IS NOT NULL);
-- One active switch per target. An org-wide switch has workspace_id NULL and a
-- workspace switch its workspace, so two partial indexes cover both (the shape
-- of pra_principal_role_org_*); flipKillSwitchOn inserts ON CONFLICT DO
-- NOTHING against the one its scope names.
CREATE UNIQUE INDEX "emergency_denies_active_target_org_uidx" ON "iam"."emergency_denies" ("org_id", "target_kind", "target_id")
  WHERE (active = true AND workspace_id IS NULL);
CREATE UNIQUE INDEX "emergency_denies_active_target_ws_uidx" ON "iam"."emergency_denies" ("org_id", "workspace_id", "target_kind", "target_id")
  WHERE (active = true AND workspace_id IS NOT NULL);
