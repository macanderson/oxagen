-- Workspace Schema Registry (Spec §4.1–§4.6 + §11 RLS).
--
-- Creates the schema_registry Postgres schema and all 7 tables:
--   §4.1  registries         (scr_…) — one non-deleted row per workspace
--   §4.2  schema_versions    (scv_…) — immutable published snapshots + draft
--   §4.3  schemas            (sch_…) — named label/reltype groups within a version
--   §4.3  schema_activations (sca_…) — workspace-scoped enabled/disabled state (not versioned)
--   §4.4  node_labels        (scl_…) — Neo4j node labels belonging to a schema
--   §4.5  relationship_types (scrt_…) — Neo4j relationship types belonging to a schema
--   §4.6  properties         (scp_…) — typed properties on a label or relationship type
--
-- §4.7: no bespoke reconcile table; reconcile reuses agent_executions.
--
-- Notes:
--   - No cross-schema FK .references() to avoid circular dependency;
--     app-enforced FKs only (mirrors agents.active_version_id pattern).
--   - Partial unique indexes (WHERE deleted_at IS NULL) replace Drizzle's
--     nullsNotDistinct() placeholder — the Atlas migration is the canonical source
--     of truth for these constraints (per F2 stream note).
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grants are handled by the dynamic loop in 20260612052000
--     (ALTER DEFAULT PRIVILEGES covers future schemas); an explicit grant block
--     is included here for safety on replays against a DB where the default
--     privilege loop ran before schema_registry was created.

-- ── Schema ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "schema_registry";

-- ── §4.1 schema_registry.registries ──────────────────────────────────────────
CREATE TABLE "schema_registry"."registries" (
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
  -- Pin pointer: FK to schema_versions.id (app-enforced, no DB FK to avoid circular dep).
  "pinned_version_id" uuid NULL,
  -- Draft pointer: the single mutable working copy.
  "draft_version_id" uuid NULL,
  -- Enforcement mode for property-level validation at ingestion time.
  "enforcement_mode" text NOT NULL DEFAULT 'lenient',
  -- Conformance floor in lenient mode. Range 0.00–1.00.
  "conformance_floor" numeric(3,2) NOT NULL DEFAULT 0.50,
  PRIMARY KEY ("id"),
  CONSTRAINT "registries_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "registries_enforcement_mode_check"
    CHECK (enforcement_mode IN ('strict', 'lenient', 'off'))
);
-- Composite index for tenant-scoped lookups.
CREATE INDEX "registries_org_workspace_idx"
  ON "schema_registry"."registries" ("org_id", "workspace_id");
-- Partial unique: exactly one live (non-deleted) registry per workspace.
CREATE UNIQUE INDEX "registries_workspace_uniq"
  ON "schema_registry"."registries" ("workspace_id")
  WHERE (deleted_at IS NULL);

-- ── §4.2 schema_registry.schema_versions ─────────────────────────────────────
-- Immutable once published. No softDeleteMixin — published versions are permanent.
CREATE TABLE "schema_registry"."schema_versions" (
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
  -- Parent registry (app-enforced FK to schema_registry.registries.id).
  "registry_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  -- 'draft' = mutable working copy; 'published' = frozen immutable snapshot.
  "status" text NOT NULL DEFAULT 'draft',
  -- Lineage pointer to the published version this was forked from.
  "parent_version_id" uuid NULL,
  -- Optional human tag e.g. "Sales CRM v2".
  "label" text NULL,
  -- AI- or user-authored change summary for the diff/changelog.
  "change_summary" text NULL,
  -- Set when draft is frozen (status → 'published').
  "published_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "schema_versions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "schema_versions_status_check"
    CHECK (status IN ('draft', 'published'))
);
-- Monotonic version counter per registry.
CREATE UNIQUE INDEX "schema_versions_registry_version_uniq"
  ON "schema_registry"."schema_versions" ("registry_id", "version_number");
CREATE INDEX "schema_versions_registry_idx"
  ON "schema_registry"."schema_versions" ("registry_id");
CREATE INDEX "schema_versions_org_workspace_idx"
  ON "schema_registry"."schema_versions" ("org_id", "workspace_id");

-- ── §4.3 schema_registry.schemas ─────────────────────────────────────────────
CREATE TABLE "schema_registry"."schemas" (
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
  -- The version snapshot this schema definition belongs to.
  "version_id" uuid NOT NULL,
  -- Stable identity within a workspace (e.g. 'salesforce_crm', 'starter').
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NULL,
  -- Origin of this schema.
  "source" text NOT NULL,
  -- Set when source='connector'.
  "connector_id" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "schemas_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "schemas_source_check"
    CHECK (source IN ('user', 'connector', 'recommended'))
);
-- A schema name is unique within a version snapshot.
CREATE UNIQUE INDEX "schemas_version_name_uniq"
  ON "schema_registry"."schemas" ("version_id", "name");
CREATE INDEX "schemas_version_idx"
  ON "schema_registry"."schemas" ("version_id");
CREATE INDEX "schemas_org_workspace_idx"
  ON "schema_registry"."schemas" ("org_id", "workspace_id");

-- ── §4.3 schema_registry.schema_activations ───────────────────────────────────
-- Current workspace enabled/disabled state. NOT versioned. Keyed on
-- (workspace_id, schema_name) so toggling a schema does not require re-versioning.
CREATE TABLE "schema_registry"."schema_activations" (
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
  -- Stable schema identity — matches schemas.name; version-independent.
  "schema_name" text NOT NULL,
  -- Current enable/disable state.
  "enabled" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "schema_activations_public_id_unique" UNIQUE ("public_id")
);
CREATE INDEX "schema_activations_org_workspace_idx"
  ON "schema_registry"."schema_activations" ("org_id", "workspace_id");
-- Partial unique: one live activation record per (workspace, schema_name).
CREATE UNIQUE INDEX "schema_activations_workspace_schema_uniq"
  ON "schema_registry"."schema_activations" ("workspace_id", "schema_name")
  WHERE (deleted_at IS NULL);

-- ── §4.4 schema_registry.node_labels ─────────────────────────────────────────
CREATE TABLE "schema_registry"."node_labels" (
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
  -- The version snapshot this label belongs to.
  "version_id" uuid NOT NULL,
  -- The schema within that version grouping this label.
  "schema_id" uuid NOT NULL,
  -- The Neo4j node label string, e.g. "Customer".
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NULL,
  -- Property names forming the dedup natural key (advisory).
  "natural_key_props" text[] NOT NULL DEFAULT '{}',
  -- Color/icon/UI hints.
  "metadata" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "node_labels_public_id_unique" UNIQUE ("public_id")
);
-- A label name is unique within a version snapshot.
CREATE UNIQUE INDEX "node_labels_version_name_uniq"
  ON "schema_registry"."node_labels" ("version_id", "name");
CREATE INDEX "node_labels_version_idx"
  ON "schema_registry"."node_labels" ("version_id");
CREATE INDEX "node_labels_schema_idx"
  ON "schema_registry"."node_labels" ("schema_id");
CREATE INDEX "node_labels_org_workspace_idx"
  ON "schema_registry"."node_labels" ("org_id", "workspace_id");

-- ── §4.5 schema_registry.relationship_types ──────────────────────────────────
CREATE TABLE "schema_registry"."relationship_types" (
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
  -- The version snapshot this relationship type belongs to.
  "version_id" uuid NOT NULL,
  -- The schema within that version grouping this relationship type.
  "schema_id" uuid NOT NULL,
  -- Neo4j relationship type name, e.g. "SIGNED_CONTRACT".
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NULL,
  -- Endpoint constraints: null = any label.
  "start_label" text NULL,
  "end_label" text NULL,
  -- Optional cardinality hint.
  "cardinality" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "relationship_types_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "relationship_types_cardinality_check"
    CHECK (cardinality IS NULL OR cardinality IN ('one_to_one', 'one_to_many', 'many_to_many'))
);
-- (name, start_label, end_label) is the identity tuple within a version.
CREATE UNIQUE INDEX "relationship_types_version_name_endpoint_uniq"
  ON "schema_registry"."relationship_types" ("version_id", "name", "start_label", "end_label");
CREATE INDEX "relationship_types_version_idx"
  ON "schema_registry"."relationship_types" ("version_id");
CREATE INDEX "relationship_types_schema_idx"
  ON "schema_registry"."relationship_types" ("schema_id");
CREATE INDEX "relationship_types_org_workspace_idx"
  ON "schema_registry"."relationship_types" ("org_id", "workspace_id");

-- ── §4.6 schema_registry.properties ──────────────────────────────────────────
-- Polymorphic owner: exactly one of node_label_id / relationship_type_id is non-null (XOR).
CREATE TABLE "schema_registry"."properties" (
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
  -- The version snapshot this property belongs to.
  "version_id" uuid NOT NULL,
  -- Polymorphic owner (XOR — exactly one must be non-null).
  "node_label_id" uuid NULL,
  "relationship_type_id" uuid NULL,
  -- Property key / name.
  "key" text NOT NULL,
  -- Data type allow-list.
  "data_type" text NOT NULL,
  "required" boolean NOT NULL DEFAULT false,
  "description" text NULL,
  -- When data_type='enum': allowed values.
  "enum_values" text[] NULL,
  -- When data_type='array': element type.
  "item_type" text NULL,
  -- min/max/minLength/maxLength/pattern constraints (mirrors connector FieldValidation).
  "constraints" jsonb NOT NULL DEFAULT '{}',
  -- Few-shot grounding example for the extraction prompt.
  "example" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "properties_public_id_unique" UNIQUE ("public_id"),
  -- XOR: exactly one owner FK must be non-null.
  CONSTRAINT "properties_owner_xor_check"
    CHECK (
      (node_label_id IS NOT NULL AND relationship_type_id IS NULL) OR
      (node_label_id IS NULL AND relationship_type_id IS NOT NULL)
    ),
  -- Data type allow-list.
  CONSTRAINT "properties_data_type_check"
    CHECK (data_type IN ('string', 'number', 'integer', 'boolean', 'date', 'datetime', 'url', 'email', 'enum', 'json', 'array'))
);
-- Uniqueness within the owning node label.
CREATE UNIQUE INDEX "properties_node_label_key_uniq"
  ON "schema_registry"."properties" ("node_label_id", "key");
-- Uniqueness within the owning relationship type.
CREATE UNIQUE INDEX "properties_rel_type_key_uniq"
  ON "schema_registry"."properties" ("relationship_type_id", "key");
CREATE INDEX "properties_version_idx"
  ON "schema_registry"."properties" ("version_id");
CREATE INDEX "properties_node_label_idx"
  ON "schema_registry"."properties" ("node_label_id");
CREATE INDEX "properties_rel_type_idx"
  ON "schema_registry"."properties" ("relationship_type_id");
CREATE INDEX "properties_org_workspace_idx"
  ON "schema_registry"."properties" ("org_id", "workspace_id");

-- ── §11 RLS — tenant_isolation on all 7 schema_registry tables ───────────────
-- Pattern: ENABLE + FORCE + DROP POLICY IF EXISTS + CREATE POLICY, matching
-- 20260612140000_restore_rls_policies.sql exactly.

ALTER TABLE schema_registry.registries ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.registries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.registries;
CREATE POLICY tenant_isolation ON schema_registry.registries
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE schema_registry.schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.schema_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.schema_versions;
CREATE POLICY tenant_isolation ON schema_registry.schema_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE schema_registry.schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.schemas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.schemas;
CREATE POLICY tenant_isolation ON schema_registry.schemas
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE schema_registry.schema_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.schema_activations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.schema_activations;
CREATE POLICY tenant_isolation ON schema_registry.schema_activations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE schema_registry.node_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.node_labels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.node_labels;
CREATE POLICY tenant_isolation ON schema_registry.node_labels
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE schema_registry.relationship_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.relationship_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.relationship_types;
CREATE POLICY tenant_isolation ON schema_registry.relationship_types
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE schema_registry.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_registry.properties FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schema_registry.properties;
CREATE POLICY tenant_isolation ON schema_registry.properties
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants for schema_registry ────────────────────────────────────
-- The dynamic loop in 20260612052000_regrant_oxagen_app.sql covers schemas
-- that exist at replay time. This block explicitly grants privileges for the
-- schema_registry schema so that environments replaying migrations in order
-- are not left without access between this migration and any future regrant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA schema_registry TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA schema_registry TO oxagen_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA schema_registry TO oxagen_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA schema_registry GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA schema_registry GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app';
  END IF;
END
$$;
