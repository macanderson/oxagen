-- Workspace agent-asset registry — tool declarations + context records
-- (stella-cutover Wave 4: oxagen workspaces aggregate everything a Stella
-- agent runs with; traces and skills already land here, this adds the two
-- missing asset classes).
--
-- Design mirrors agent.skills / agent.skill_versions exactly: a logical
-- identity row keyed (workspace_id, slug) plus immutable version snapshots
-- with is_latest / version_number, an explicitly pinned active_version_id,
-- and soft delete on the identity row only.
--
--   - agent.tools / agent.tool_versions: one row per declared tool contract
--     (Stella ToolContract vocabulary: name, description, JSON input schema,
--     read_only flag, risk grade, policy group) with a source discriminator
--     (builtin | custom | mcp | foundry), a SHA-256 checksum over the
--     canonical manifest, and the full manifest body per version.
--   - agent.context_records / agent.context_record_versions: one row per
--     steering/context record (Stella keeps these as .stella/rules/*.toml,
--     one record per file); a version snapshots the canonical body plus a
--     provenance array (ContextProvenanceV1 vocabulary: type/uri/digest/
--     method/by).
--   - agent.context_promotions: APPEND-ONLY hash-chained ledger of record
--     lifecycle actions (promote/retire/supersede), mirroring Stella's
--     promotions.jsonl: chain_digest = sha256(prev_digest + canonical row),
--     seq monotonic per record. Grants are SELECT + INSERT only — a
--     promotion is evidence, never garbage to collect.
--
-- Notes:
--   - The agent schema already exists; no CREATE SCHEMA needed.
--   - No cross-schema FK .references(); app-enforced FKs per CLAUDE.md.
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grant is additive + idempotent (schema-level grants preexist).
--   - Plain DDL only (RDS-compatible; no superuser-only features).

-- ── agent.tools ───────────────────────────────────────────────────────────────
CREATE TABLE "agent"."tools" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  -- Where the declaration came from: shipped built-in, workspace-authored
  -- custom script, an MCP server's advertised tool, or the tool foundry.
  "source" public.citext NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  -- Explicitly pinned active version (FK added after tool_versions below).
  "active_version_id" uuid NULL,
  "activated_by_user_id" uuid NULL,
  "activated_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "tools_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "tools_source_check" CHECK (source IN ('builtin', 'custom', 'mcp', 'foundry'))
);
CREATE UNIQUE INDEX "tools_workspace_slug_idx" ON "agent"."tools" ("workspace_id", "slug");
CREATE INDEX "tools_org_idx" ON "agent"."tools" ("org_id", "workspace_id");
CREATE INDEX "tools_active_version_idx" ON "agent"."tools" ("active_version_id");

-- ── agent.tool_versions ───────────────────────────────────────────────────────
CREATE TABLE "agent"."tool_versions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid NULL,
  "published_at" timestamptz NULL,
  "tool_id" uuid NOT NULL,
  -- The tool's JSON Schema for its input parameters.
  "input_schema" jsonb NOT NULL,
  "read_only" boolean NOT NULL DEFAULT false,
  "risk_grade" text NOT NULL,
  "policy_group" text NULL,
  -- The full declared manifest body, verbatim.
  "manifest" jsonb NOT NULL,
  -- SHA-256 hex over the canonical (sorted-key) manifest JSON — immutability
  -- contract (see skill_versions.checksum).
  "checksum" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "tool_versions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "tool_versions_risk_grade_check" CHECK (risk_grade IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "tool_versions_checksum_check" CHECK (checksum ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "tool_versions_tool_idx" ON "agent"."tool_versions" ("tool_id");
CREATE UNIQUE INDEX "tool_versions_tool_latest_idx" ON "agent"."tool_versions" ("tool_id") WHERE (is_latest = true);
CREATE UNIQUE INDEX "tool_versions_tool_version_idx" ON "agent"."tool_versions" ("tool_id", "version_number");
CREATE INDEX "tool_versions_org_idx" ON "agent"."tool_versions" ("org_id", "workspace_id");

-- Same-schema FK for the pinned active version (mirrors
-- skills_active_version_id_skill_versions_id_fk).
ALTER TABLE "agent"."tools"
  ADD CONSTRAINT "tools_active_version_id_tool_versions_id_fk"
  FOREIGN KEY ("active_version_id") REFERENCES "agent"."tool_versions" ("id");

-- ── agent.context_records ─────────────────────────────────────────────────────
CREATE TABLE "agent"."context_records" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  -- The record id — the .stella/rules/<slug>.toml file stem.
  "slug" public.citext NOT NULL,
  "title" text NOT NULL,
  -- Lifecycle driven by the context_promotions ledger:
  -- promote → active, retire → retired, supersede → superseded.
  "status" text NOT NULL DEFAULT 'active',
  "active_version_id" uuid NULL,
  "activated_by_user_id" uuid NULL,
  "activated_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "context_records_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "context_records_status_check" CHECK (status IN ('active', 'retired', 'superseded'))
);
CREATE UNIQUE INDEX "context_records_workspace_slug_idx" ON "agent"."context_records" ("workspace_id", "slug");
CREATE INDEX "context_records_org_idx" ON "agent"."context_records" ("org_id", "workspace_id");
CREATE INDEX "context_records_active_version_idx" ON "agent"."context_records" ("active_version_id");

-- ── agent.context_record_versions ─────────────────────────────────────────────
CREATE TABLE "agent"."context_record_versions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid NULL,
  "published_at" timestamptz NULL,
  "record_id" uuid NOT NULL,
  -- The canonical record body (Stella keeps one TOML record per file).
  "body" text NOT NULL,
  -- SHA-256 hex over body — immutability contract (see skill_versions).
  "checksum" text NOT NULL,
  -- ContextProvenanceV1 vocabulary (packages/run-evidence contextgraph.ts):
  -- [{ type, uri?, range?, digest?, method?, by? }].
  "provenance" jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY ("id"),
  CONSTRAINT "context_record_versions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "context_record_versions_checksum_check" CHECK (checksum ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "context_record_versions_record_idx" ON "agent"."context_record_versions" ("record_id");
CREATE UNIQUE INDEX "context_record_versions_record_latest_idx" ON "agent"."context_record_versions" ("record_id") WHERE (is_latest = true);
CREATE UNIQUE INDEX "context_record_versions_record_version_idx" ON "agent"."context_record_versions" ("record_id", "version_number");
CREATE INDEX "context_record_versions_org_idx" ON "agent"."context_record_versions" ("org_id", "workspace_id");

ALTER TABLE "agent"."context_records"
  ADD CONSTRAINT "context_records_active_version_id_context_record_versions_id_fk"
  FOREIGN KEY ("active_version_id") REFERENCES "agent"."context_record_versions" ("id");

-- ── agent.context_promotions — append-only hash-chained ledger ────────────────
CREATE TABLE "agent"."context_promotions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "record_id" uuid NOT NULL,
  -- The version being promoted/superseded-by; NULL for a retire.
  "version_id" uuid NULL,
  -- Monotonic per record, starting at 1 — the chain order.
  "seq" integer NOT NULL,
  "action" text NOT NULL,
  "approver_user_id" uuid NULL,
  "policy_version" text NOT NULL,
  -- The previous entry's chain_digest; NULL only for seq = 1.
  "prev_chain_digest" text NULL,
  -- sha256(prev_chain_digest + canonical row), hex — mirrors Stella's
  -- hash-chained promotions.jsonl.
  "chain_digest" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "context_promotions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "context_promotions_action_check" CHECK (action IN ('promote', 'retire', 'supersede')),
  CONSTRAINT "context_promotions_seq_check" CHECK (seq > 0),
  CONSTRAINT "context_promotions_chain_check" CHECK (
    chain_digest ~ '^[0-9a-f]{64}$'
    AND (prev_chain_digest IS NULL OR prev_chain_digest ~ '^[0-9a-f]{64}$')
    AND ((seq = 1) = (prev_chain_digest IS NULL))
  )
);
CREATE UNIQUE INDEX "context_promotions_record_seq_idx" ON "agent"."context_promotions" ("record_id", "seq");
CREATE INDEX "context_promotions_org_idx" ON "agent"."context_promotions" ("org_id", "workspace_id");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE agent.tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.tools;
CREATE POLICY tenant_isolation ON agent.tools
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.tool_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.tool_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.tool_versions;
CREATE POLICY tenant_isolation ON agent.tool_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.context_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.context_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.context_records;
CREATE POLICY tenant_isolation ON agent.context_records
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.context_record_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.context_record_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.context_record_versions;
CREATE POLICY tenant_isolation ON agent.context_record_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.context_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.context_promotions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.context_promotions;
CREATE POLICY tenant_isolation ON agent.context_promotions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
-- context_promotions is append-only at the grant level: SELECT + INSERT and
-- never UPDATE/DELETE — a promotion is evidence, not state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.tools TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.tool_versions TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.context_records TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.context_record_versions TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON agent.context_promotions TO oxagen_app';
  END IF;
END
$$;
