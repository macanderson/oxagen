/**
 * schema_registry — Workspace Schema Registry (Spec §4).
 *
 * The registry is the authoritative, versioned, workspace-scoped vocabulary
 * (node labels + relationship types + properties) that governs a workspace's
 * knowledge graph. It is not an observation cache — observations live in
 * ClickHouse `graph_observed_labels` (§4.9).
 *
 * Tables:
 *   §4.1  registries          (scr_…) — one per workspace; pin pointer + config
 *   §4.2  schema_versions     (scv_…) — immutable published snapshots + working draft
 *   §4.3  schemas             (sch_…) — named label/reltype groups within a version
 *   §4.3  schema_activations  (sca_…) — current workspace enabled/disabled config (not versioned)
 *   §4.4  node_labels         (scl_…) — node labels belonging to a schema
 *   §4.5  relationship_types  (scrt_…) — relationship types belonging to a schema
 *   §4.6  properties          (scp_…) — typed properties on a label or relationship type
 *
 * §4.7 — No bespoke reconcile table; reconcile reuses agent_executions.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { schemaRegistrySchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin, softDeleteMixin } from "./_mixins";

// ── §4.1 schema_registry.registries ──────────────────────────────────────────
// One non-deleted row per workspace. Holds the pin + draft pointers and
// per-workspace enforcement configuration.

export const schemaRegistries = schemaRegistrySchema.table(
  "registries",
  {
    ...idMixin("scr"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // Pin pointer: null until the first version is published + pinned.
    // Forward ref — no .references() to avoid circular dependency between
    // registries ↔ schema_versions; the FK is enforced via the Atlas migration.
    pinnedVersionId: uuid("pinned_version_id"),
    // Draft pointer: points to the single mutable working-copy version (status='draft').
    draftVersionId: uuid("draft_version_id"),
    // Enforcement mode for property-level validation at ingestion time (§2.1 criterion 9).
    enforcementMode: text("enforcement_mode").notNull().default("lenient"),
    // When lenient mode is active, a conformance score below this floor raises
    // a schema.conformance.low event. Range 0.00–1.00.
    conformanceFloor: numeric("conformance_floor", { precision: 3, scale: 2 })
      .notNull()
      .default("0.50"),
  },
  (t) => ({
    // Exactly one live registry per workspace.
    workspaceUniq: unique("registries_workspace_uniq")
      .on(t.workspaceId)
      .nullsNotDistinct(), // partial-unique semantics enforced at DB via WHERE in Atlas migration
    orgWorkspaceIdx: index("registries_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    enforcementModeCheck: check(
      "registries_enforcement_mode_check",
      sql`${t.enforcementMode} IN ('strict', 'lenient', 'off')`,
    ),
  }),
);

// ── §4.2 schema_registry.schema_versions ─────────────────────────────────────
// Immutable snapshots. Once a version is published it is INSERT-only.
// No soft delete: published versions are permanent historical records.

export const schemaVersions = schemaRegistrySchema.table(
  "schema_versions",
  {
    ...idMixin("scv"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // Parent registry — no .references() to mirror the cross-domain pattern.
    registryId: uuid("registry_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    // 'draft' is the mutable working copy; 'published' is frozen.
    status: text("status").notNull().default("draft"),
    // Lineage: which published version this was forked from (null for the first version).
    parentVersionId: uuid("parent_version_id"),
    // Optional human tag (e.g. "Sales CRM v2").
    label: text("label"),
    // AI- or user-authored summary for the diff/changelog.
    changeSummary: text("change_summary"),
    // Set when the draft is frozen (status → 'published').
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    // One version number per registry (monotonic counter).
    registryVersionUniq: unique("schema_versions_registry_version_uniq").on(
      t.registryId,
      t.versionNumber,
    ),
    registryIdx: index("schema_versions_registry_idx").on(t.registryId),
    orgWorkspaceIdx: index("schema_versions_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    statusCheck: check(
      "schema_versions_status_check",
      sql`${t.status} IN ('draft', 'published')`,
    ),
  }),
);

// ── §4.3 schema_registry.schemas ─────────────────────────────────────────────
// A named group of labels + relationship types belonging to one version snapshot.
// Definitions are immutable once the version is published; enabled-state lives
// in schema_activations (below).

export const schemas = schemaRegistrySchema.table(
  "schemas",
  {
    ...idMixin("sch"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // The version snapshot this schema definition belongs to.
    versionId: uuid("version_id").notNull(),
    // Stable identity within a workspace (e.g. 'salesforce_crm', 'starter').
    // Survives across versions; activation is keyed on this name.
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    // Origin of this schema.
    source: text("source").notNull(),
    // Set when source='connector'; the contributing connector plugin id.
    connectorId: text("connector_id"),
  },
  (t) => ({
    // A schema name is unique within a version snapshot.
    versionNameUniq: unique("schemas_version_name_uniq").on(
      t.versionId,
      t.name,
    ),
    versionIdx: index("schemas_version_idx").on(t.versionId),
    orgWorkspaceIdx: index("schemas_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    sourceCheck: check(
      "schemas_source_check",
      sql`${t.source} IN ('user', 'connector', 'recommended')`,
    ),
  }),
);

// ── §4.3 schema_registry.schema_activations ───────────────────────────────────
// Current workspace enabled/disabled state — NOT versioned.
// Keyed on workspace_id + schema_name (stable identity across versions) so that
// toggling a schema does not require re-versioning a frozen snapshot (§1.4).

export const schemaActivations = schemaRegistrySchema.table(
  "schema_activations",
  {
    ...idMixin("sca"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // Stable schema identity — matches schemas.name; version-independent.
    schemaName: text("schema_name").notNull(),
    // Current enable/disable state. Connector schemas default on; user/AI/recommended
    // schemas are explicitly born off (§4.3 born-disabled rule).
    enabled: boolean("enabled").notNull().default(true),
    // Separate updatedAt for the toggle timestamp (auditMixin provides this via updatedAt).
  },
  (t) => ({
    // One live activation record per (workspace, schema_name).
    workspaceSchemaUniq: unique("schema_activations_workspace_schema_uniq")
      .on(t.workspaceId, t.schemaName)
      .nullsNotDistinct(),
    orgWorkspaceIdx: index("schema_activations_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

// ── §4.4 schema_registry.node_labels ─────────────────────────────────────────
// A node label belongs to exactly one schema within one version snapshot.

export const nodeLabels = schemaRegistrySchema.table(
  "node_labels",
  {
    ...idMixin("scl"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // The version snapshot this label belongs to.
    versionId: uuid("version_id").notNull(),
    // The schema within that version that groups this label.
    schemaId: uuid("schema_id").notNull(),
    // Label string — this IS the Neo4j node label (§1.2.1), e.g. "Customer".
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    // Grounds the ingestion AI on what this label represents.
    description: text("description"),
    // Property names forming the dedup natural key (advisory).
    naturalKeyProps: text("natural_key_props")
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => ({
    // A label name is unique within a version snapshot.
    versionNameUniq: unique("node_labels_version_name_uniq").on(
      t.versionId,
      t.name,
    ),
    versionIdx: index("node_labels_version_idx").on(t.versionId),
    schemaIdx: index("node_labels_schema_idx").on(t.schemaId),
    orgWorkspaceIdx: index("node_labels_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

// ── §4.5 schema_registry.relationship_types ──────────────────────────────────
// A relationship type belongs to exactly one schema within one version snapshot.

export const relationshipTypes = schemaRegistrySchema.table(
  "relationship_types",
  {
    ...idMixin("scrt"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // The version snapshot this relationship type belongs to.
    versionId: uuid("version_id").notNull(),
    // The schema within that version that groups this relationship type.
    schemaId: uuid("schema_id").notNull(),
    // Neo4j relationship type name, e.g. "SIGNED_CONTRACT". Validated by
    // RELATIONSHIP_TYPE_PATTERN at the application layer (§3.2).
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    // Grounds the AI on when this relationship applies.
    description: text("description"),
    // Endpoint constraints: start and end node labels (null = any label).
    startLabel: text("start_label"),
    endLabel: text("end_label"),
    // Optional cardinality hint.
    cardinality: text("cardinality"),
  },
  (t) => ({
    // (name, start_label, end_label) is the identity tuple within a version —
    // the same relationship type name can appear with different endpoint constraints.
    versionNameEndpointUniq: unique(
      "relationship_types_version_name_endpoint_uniq",
    ).on(t.versionId, t.name, t.startLabel, t.endLabel),
    versionIdx: index("relationship_types_version_idx").on(t.versionId),
    schemaIdx: index("relationship_types_schema_idx").on(t.schemaId),
    orgWorkspaceIdx: index("relationship_types_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    cardinalityCheck: check(
      "relationship_types_cardinality_check",
      sql`${t.cardinality} IS NULL OR ${t.cardinality} IN ('one_to_one', 'one_to_many', 'many_to_many')`,
    ),
  }),
);

// ── §4.6 schema_registry.properties ──────────────────────────────────────────
// Polymorphic owner: exactly one of node_label_id / relationship_type_id is set.

export const schemaProperties = schemaRegistrySchema.table(
  "properties",
  {
    ...idMixin("scp"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // The version snapshot this property belongs to.
    versionId: uuid("version_id").notNull(),
    // Polymorphic owner — exactly one must be non-null (XOR CHECK below).
    nodeLabelId: uuid("node_label_id"),
    relationshipTypeId: uuid("relationship_type_id"),
    // Property key / name.
    key: text("key").notNull(),
    // Data type.
    dataType: text("data_type").notNull(),
    required: boolean("required").notNull().default(false),
    // The grounding field — what to collect, where to find it.
    description: text("description"),
    // When data_type='enum': the allowed values.
    enumValues: text("enum_values").array(),
    // When data_type='array': the element type.
    itemType: text("item_type"),
    // min/max/minLength/maxLength/pattern — mirrors connector FieldValidation shape.
    constraints: jsonb("constraints").notNull().default(sql`'{}'::jsonb`),
    // Few-shot grounding example for the extraction prompt.
    example: text("example"),
  },
  (t) => ({
    // Uniqueness within the owning label or relationship type.
    nodeLabelKeyUniq: unique("properties_node_label_key_uniq").on(
      t.nodeLabelId,
      t.key,
    ),
    relTypeKeyUniq: unique("properties_rel_type_key_uniq").on(
      t.relationshipTypeId,
      t.key,
    ),
    versionIdx: index("properties_version_idx").on(t.versionId),
    nodeLabelIdx: index("properties_node_label_idx").on(t.nodeLabelId),
    relTypeIdx: index("properties_rel_type_idx").on(t.relationshipTypeId),
    orgWorkspaceIdx: index("properties_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    // XOR: exactly one owner FK must be non-null.
    ownerXorCheck: check(
      "properties_owner_xor_check",
      sql`(${t.nodeLabelId} IS NOT NULL AND ${t.relationshipTypeId} IS NULL) OR (${t.nodeLabelId} IS NULL AND ${t.relationshipTypeId} IS NOT NULL)`,
    ),
    // Data type allow-list.
    dataTypeCheck: check(
      "properties_data_type_check",
      sql`${t.dataType} IN ('string', 'number', 'integer', 'boolean', 'date', 'datetime', 'url', 'email', 'enum', 'json', 'array')`,
    ),
  }),
);
