-- 0002_ingestion_ontology.sql
-- Workspace-scoped ontology configuration: entity type registry (auto-upserted
-- on every pipeline write), customer-configured source → entity type mappings,
-- and LLM-generated setup suggestions from the connection wizard.

-- ── ingestion.entity_types ───────────────────────────────────────────────────
-- One row per unique entity type string per workspace. Auto-upserted by the
-- ingestion pipeline on every successful write — no pre-registration required.
-- Operators can also add custom types manually (is_custom = true).
-- The unique constraint on (workspace_id, name) enforces one ontology per workspace.

CREATE TABLE ingestion.entity_types (
  id                    UUID        NOT NULL DEFAULT COALESCE(
                                      CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                        THEN uuid_generate_v7()
                                        ELSE uuid_generate_v4()
                                      END,
                                      uuid_generate_v4()
                                    ),
  public_id             CITEXT      NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id          UUID        NOT NULL,
  org_id                UUID        NOT NULL,
  -- snake_case type string e.g. "task", "document", "code_change", "contact"
  name                  TEXT        NOT NULL,
  -- Human-readable label shown in UI and used in LLM prompts
  display_name          TEXT        NOT NULL,
  -- Fed to the inference worker and setup wizard LLM prompts for context
  description           TEXT,
  -- Top-N property keys seen on this type; recomputed by a periodic background job
  common_property_keys  TEXT[]      NOT NULL DEFAULT '{}',
  -- Declared relationships: [{ "edge_type": "PART_OF", "target_type": "project" }]
  -- Drives the Workspace Linker inference worker that proposes edges nightly
  expected_edges        JSONB       NOT NULL DEFAULT '[]',
  -- Materialized count of live nodes of this type in Neo4j (eventually consistent)
  row_count             INTEGER     NOT NULL DEFAULT 0,
  last_seen_at          TIMESTAMPTZ,
  -- false = auto-registered by connector pipeline; true = explicitly created by operator
  is_custom             BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  -- Workspace ontology is unique per (workspace, name) — same name in two
  -- workspaces are independent types with no relationship.
  CONSTRAINT entity_types_workspace_name_uniq UNIQUE (workspace_id, name)
);

CREATE INDEX entity_types_workspace_org_idx ON ingestion.entity_types (workspace_id, org_id);
CREATE INDEX entity_types_last_seen_idx      ON ingestion.entity_types (last_seen_at DESC NULLS LAST);

-- ── ingestion.entity_type_mappings ───────────────────────────────────────────
-- Customer-configured translation table: connector source record type →
-- workspace entity type string. Set during the setup wizard; editable later.
-- The pipeline resolves this at Stage 2 (Map) before normalization.
-- property_mappings: { "source.field.path": "canonical_property_name" }

CREATE TABLE ingestion.entity_type_mappings (
  id                    UUID        NOT NULL DEFAULT COALESCE(
                                      CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                        THEN uuid_generate_v7()
                                        ELSE uuid_generate_v4()
                                      END,
                                      uuid_generate_v4()
                                    ),
  public_id             CITEXT      NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connection_id         UUID        NOT NULL,
  workspace_id          UUID        NOT NULL,
  org_id                UUID        NOT NULL,
  -- The connector's raw record type: "pull_request", "issue", "commit"
  source_record_type    TEXT        NOT NULL,
  -- The customer's entity type string for this workspace: "task", "code_change"
  oxagen_entity_type    TEXT        NOT NULL,
  -- Field-level mapping: { "user.login": "author", "title": "title", "body": "description" }
  -- Dot-notation paths resolve nested source fields to flat canonical property names.
  property_mappings     JSONB       NOT NULL DEFAULT '{}',
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  -- One mapping per (connection, source_record_type) — a single source type
  -- maps to exactly one entity type per connection instance.
  CONSTRAINT entity_type_mappings_connection_type_uniq UNIQUE (connection_id, source_record_type),
  CONSTRAINT entity_type_mappings_connection_fk
    FOREIGN KEY (connection_id) REFERENCES ingestion.source_connections(id) ON DELETE CASCADE
);

CREATE INDEX entity_type_mappings_connection_idx     ON ingestion.entity_type_mappings (connection_id);
CREATE INDEX entity_type_mappings_workspace_type_idx ON ingestion.entity_type_mappings (workspace_id, oxagen_entity_type);

-- ── ingestion.setup_suggestions ─────────────────────────────────────────────
-- LLM-generated entity type and property mapping suggestions produced during
-- the connection setup wizard. Persisted until the user accepts or rejects them.
-- On accept → row is copied into entity_type_mappings; on reject → discarded.

CREATE TABLE ingestion.setup_suggestions (
  id                          UUID        NOT NULL DEFAULT COALESCE(
                                            CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                              THEN uuid_generate_v7()
                                              ELSE uuid_generate_v4()
                                            END,
                                            uuid_generate_v4()
                                          ),
  public_id                   CITEXT      NOT NULL UNIQUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connection_id               UUID        NOT NULL,
  workspace_id                UUID        NOT NULL,
  source_record_type          TEXT        NOT NULL,
  suggested_entity_type       TEXT        NOT NULL,
  suggested_property_mappings JSONB       NOT NULL DEFAULT '{}',
  -- LLM reasoning shown to the user in the setup wizard
  reasoning                   TEXT,
  -- pending | accepted | rejected | modified
  status                      TEXT        NOT NULL DEFAULT 'pending',
  resolved_at                 TIMESTAMPTZ,
  resolved_by                 UUID,
  PRIMARY KEY (id),
  CONSTRAINT setup_suggestions_connection_fk
    FOREIGN KEY (connection_id) REFERENCES ingestion.source_connections(id) ON DELETE CASCADE,
  CONSTRAINT setup_suggestions_status_chk
    CHECK (status IN ('pending','accepted','rejected','modified'))
);

CREATE INDEX setup_suggestions_connection_idx ON ingestion.setup_suggestions (connection_id);
CREATE INDEX setup_suggestions_status_idx      ON ingestion.setup_suggestions (status) WHERE status = 'pending';
