/**
 * environments — Agent Environments & Credential Vault (Spec:
 * docs/superpowers/specs/2026-06-24-credential-vault-environments-sandboxes-spec.md §5).
 *
 * Phase 0 ("Vault + Environments core", §18) shipped four tables. Phase 1
 * ("Sandbox templates + portable artifacts", §5.2–§5.3, §5.6) adds three more.
 * Network agents (§5.8) still land with their owning ticket so nothing ships
 * as dead schema.
 *
 * Tables:
 *   §5.1  environments               (env_…) — one is_default per workspace; seeded "default"
 *   §5.4  secret_keys                (sk_…)  — vault root: key + sensitive flag + default value
 *   §5.5  secret_values              (sv_…)  — per-(key, environment) overrides
 *   §5.7  secret_access_log                  — append-only audit for reveal/export (§7.3)
 *   §5.2  sandbox_templates          (sbx_…) — portable sandbox config; one is_default per environment
 *   §5.3  sandbox_template_tools     (sbt_…) — preloaded tools for a template (replace-set)
 *   §5.6  agent_environment_bindings (aeb_…) — agent → (environment, template); one is_primary per agent
 *
 * Conventions mirror schema-registry.ts:
 *   - No cross-schema FK .references() (app-enforced FKs avoid circular deps).
 *   - Partial-unique indexes are declared here as
 *     `uniqueIndex(...).where(...)`, spelling the SAME predicate the Atlas
 *     migration created. The Drizzle schema is what `drizzle-kit export` feeds
 *     Atlas (atlas.hcl), so a bare `unique()` standing in for a partial index
 *     declares a STRICTER constraint than the database actually has and makes
 *     the next `atlas migrate diff` want to replace the partial index with a
 *     full one. Keep the two spellings identical.
 *   - Sensitive values are envelope-encrypted by the service layer into the
 *     *_enc bytea columns; non-sensitive config lives in *_text (§7.2).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { environmentsSchema } from "./_schemas";
import {
  auditMixin,
  bytea,
  citext,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";

// ── §5.1 environments.environments ───────────────────────────────────────────
// A workspace environment (production / development / preview / …). Exactly one
// row per workspace carries is_default=true (DB partial-unique + handler guard);
// runs that don't name an environment resolve to it.

export const environments = environmentsSchema.table(
  "environments",
  {
    ...idMixin("env"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    // Case-insensitive workspace-unique handle (e.g. 'default', 'production').
    slug: citext("slug").notNull(),
    description: text("description"),
    // Exactly one default per workspace — see partial-unique in the migration.
    isDefault: boolean("is_default").notNull().default(false),
    // Deactivating stops new runs resolving here; in-flight runs finish.
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    // One LIVE environment per (workspace, slug) — a soft-deleted row frees the
    // slug for reuse.
    workspaceSlugUniq: uniqueIndex("environments_workspace_slug_uniq")
      .on(t.workspaceId, t.slug)
      .where(sql`deleted_at IS NULL`),
    // Exactly one default per workspace (the only-one-default invariant).
    workspaceDefaultUniq: uniqueIndex("environments_workspace_default_uniq")
      .on(t.workspaceId)
      .where(sql`is_default AND deleted_at IS NULL`),
    orgWorkspaceIdx: index("environments_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

// ── §5.4 environments.secret_keys ────────────────────────────────────────────
// Vault root. A key is workspace-scoped (shared across environments via the
// override model). `sensitive` (default true) governs storage for BOTH the
// default value and every override: encrypted *_enc vs plaintext *_text.

export const secretKeys = environmentsSchema.table(
  "secret_keys",
  {
    ...idMixin("sk"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // Env-var name. Validated ^[A-Za-z_][A-Za-z0-9_]*$ at the service layer.
    key: text("key").notNull(),
    sensitive: boolean("sensitive").notNull().default(true),
    memo: text("memo"),
    // Default value used when an environment has no override (§5.5 resolution).
    // Exactly one storage column is populated per `sensitive` (XOR check below);
    // both null means "no default" (resolves to unset unless an override exists).
    defaultValueEnc: bytea("default_value_enc"),
    defaultValueText: text("default_value_text"),
    defaultValueKmsKeyId: text("default_value_kms_key_id"),
  },
  (t) => ({
    // One LIVE key per (workspace, key) — a soft-deleted row frees the name.
    workspaceKeyUniq: uniqueIndex("secret_keys_workspace_key_uniq")
      .on(t.workspaceId, t.key)
      .where(sql`deleted_at IS NULL`),
    orgWorkspaceIdx: index("secret_keys_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    // Sensitive keys store only ciphertext; non-sensitive keys store only text.
    storageCheck: check(
      "secret_keys_default_storage_check",
      sql`(${t.sensitive} AND ${t.defaultValueText} IS NULL) OR (NOT ${t.sensitive} AND ${t.defaultValueEnc} IS NULL)`,
    ),
  }),
);

// ── §5.5 environments.secret_values ──────────────────────────────────────────
// A per-(key, environment) override. Storage column follows the owning key's
// `sensitive` flag (enforced at the service layer; the DB check only forbids
// populating both columns at once). Hard-deleted by secret.value.unset — an
// override carries no independent audit need beyond the access log.

export const secretValues = environmentsSchema.table(
  "secret_values",
  {
    ...idMixin("sv"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // App-enforced FKs (no .references() — mirrors the cross-schema pattern).
    secretKeyId: uuid("secret_key_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
    valueEnc: bytea("value_enc"),
    valueText: text("value_text"),
    valueKmsKeyId: text("value_kms_key_id"),
  },
  (t) => ({
    // One override per (key, environment).
    keyEnvUniq: unique("secret_values_key_env_uniq").on(
      t.secretKeyId,
      t.environmentId,
    ),
    environmentIdx: index("secret_values_environment_idx").on(t.environmentId),
    orgWorkspaceIdx: index("secret_values_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    // Never both ciphertext and plaintext on one override.
    storageCheck: check(
      "secret_values_storage_check",
      sql`NOT (${t.valueEnc} IS NOT NULL AND ${t.valueText} IS NOT NULL)`,
    ),
  }),
);

// ── §5.7 environments.secret_access_log ──────────────────────────────────────
// Append-only audit of every plaintext reveal/export (§7.3). The deliberate
// Google-Secret-Manager posture: secrets ARE retrievable by authorized
// principals, but every access is recorded. No soft delete (it is the record);
// no audit mixin (it has no author beyond actor_user_id).

export const secretAccessLog = environmentsSchema.table(
  "secret_access_log",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    actorUserId: uuid("actor_user_id"),
    // 'reveal' = single value; 'export' = a decrypted set (§7.3).
    action: text("action").notNull(),
    // { keyPublicIds?: string[], environmentId?: string, count: number }.
    scope: jsonb("scope").notNull().default(sql`'{}'::jsonb`),
    requestId: text("request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgWorkspaceIdx: index("secret_access_log_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    occurredAtIdx: index("secret_access_log_occurred_at_idx").on(t.occurredAt),
    actionCheck: check(
      "secret_access_log_action_check",
      sql`${t.action} IN ('reveal', 'export')`,
    ),
  }),
);

// ── §5.2 environments.sandbox_templates ──────────────────────────────────────
// A portable sandbox configuration bound to one environment: which provider &
// image to run, resource caps, network posture, which vault keys to inject, and
// non-sensitive literal config. Exactly one row per (workspace, environment)
// carries is_default=true (DB partial-unique + handler guard). Templates are
// EXPORTABLE as versioned manifests (secret NAMES only, never values) so a third
// party can distribute a pre-optimized config via the plugin/marketplace path.

export const sandboxTemplates = environmentsSchema.table(
  "sandbox_templates",
  {
    ...idMixin("sbx"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // App-enforced FK to environments.id (no .references() — cross-schema pattern).
    environmentId: uuid("environment_id").notNull(),
    name: text("name").notNull(),
    // Case-insensitive workspace-unique handle (e.g. 'swe-bench-prewarmed').
    slug: citext("slug").notNull(),
    description: text("description"),
    // Exactly one default per (workspace, environment) — see partial-unique in
    // the migration. Runs that don't name a template resolve to it.
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    // 'modal' | 'vercel' | 'docker'. Validated in zod (not a DB enum — extensible).
    provider: text("provider").notNull().default("modal"),
    // Image ref (digest-pinned encouraged) or language tag; null = driver default.
    runtime: text("runtime"),
    // { vcpu?, memoryMb?, timeoutMs?, diskMb? } — bounded in zod.
    resources: jsonb("resources").notNull().default(sql`'{}'::jsonb`),
    // { mode, config? } — mode ∈ public|static_egress|aws_privatelink|gcp_psc|
    // reverse_tunnel|ssh_bastion (provisioner fails fast on unimplemented modes).
    network: jsonb("network")
      .notNull()
      .default(sql`'{"mode":"public"}'::jsonb`),
    // 'all' | { keyPublicIds: string[] } — which vault keys resolve for this run.
    secretSelection: jsonb("secret_selection")
      .notNull()
      .default(sql`'"all"'::jsonb`),
    // Non-sensitive literal KEY=value config (§19.3). NEVER secrets.
    literalEnv: jsonb("literal_env").notNull().default(sql`'{}'::jsonb`),
    // Per-ecosystem package lists installed into the image at provision time:
    // [{ manager: 'pip'|'npm'|'apt'|…, names: string[] }]. Validated in zod
    // (sandboxTemplatePackagesSchema) — not a DB enum (the manager set is extensible).
    packages: jsonb("packages").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => ({
    // One LIVE template per (workspace, slug) — a soft-deleted row frees the slug.
    workspaceSlugUniq: uniqueIndex("sandbox_templates_workspace_slug_uniq")
      .on(t.workspaceId, t.slug)
      .where(sql`deleted_at IS NULL`),
    // Exactly one default per (workspace, environment).
    workspaceEnvDefaultUniq: uniqueIndex(
      "sandbox_templates_workspace_env_default_uniq",
    )
      .on(t.workspaceId, t.environmentId)
      .where(sql`is_default AND deleted_at IS NULL`),
    orgWorkspaceIdx: index("sandbox_templates_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    environmentIdx: index("sandbox_templates_environment_idx").on(
      t.environmentId,
    ),
  }),
);

// ── §5.3 environments.sandbox_template_tools ─────────────────────────────────
// Tools preloaded into a template's sandbox at provision time. Replace-set
// semantics (setTemplateTools swaps the whole set in one tx). `ref` is a
// capability name / MCP server id / skill ref / tool id per `kind`; unknown refs
// at provision time are skipped with a logged warning (portability must not
// hard-depend on the target workspace's installed plugins).

export const sandboxTemplateTools = environmentsSchema.table(
  "sandbox_template_tools",
  {
    ...idMixin("sbt"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // App-enforced FK to sandbox_templates.id.
    sandboxTemplateId: uuid("sandbox_template_id").notNull(),
    // 'capability' | 'mcp_server' | 'agent_skill' | 'tool' (DB check below).
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    // One row per (template, kind, ref).
    templateKindRefUniq: unique(
      "sandbox_template_tools_template_kind_ref_uniq",
    ).on(t.sandboxTemplateId, t.kind, t.ref),
    templateIdx: index("sandbox_template_tools_template_idx").on(
      t.sandboxTemplateId,
    ),
    orgWorkspaceIdx: index("sandbox_template_tools_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    kindCheck: check(
      "sandbox_template_tools_kind_check",
      sql`${t.kind} IN ('capability', 'mcp_server', 'agent_skill', 'tool')`,
    ),
  }),
);

// ── §5.6 environments.agent_environment_bindings ─────────────────────────────
// Binds an agent to an environment (and optionally a specific template within
// it). Exactly one binding per agent carries is_primary=true (DB partial-unique
// + handler guard) — the one used when a run doesn't name an environment. A null
// sandbox_template_id means "use the environment's default template". Bindings
// stay OUT of agent_versions.config (mutable operational config).

export const agentEnvironmentBindings = environmentsSchema.table(
  "agent_environment_bindings",
  {
    ...idMixin("aeb"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // App-enforced FKs (no .references() — cross-schema pattern).
    agentId: uuid("agent_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
    // Null → resolve to the environment's default template at run time.
    sandboxTemplateId: uuid("sandbox_template_id"),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => ({
    // One binding per (agent, environment).
    agentEnvUniq: unique("agent_environment_bindings_agent_env_uniq").on(
      t.agentId,
      t.environmentId,
    ),
    // Exactly one primary binding per agent.
    agentPrimaryUniq: uniqueIndex(
      "agent_environment_bindings_agent_primary_uniq",
    )
      .on(t.agentId)
      .where(sql`is_primary`),
    agentIdx: index("agent_environment_bindings_agent_idx").on(t.agentId),
    orgWorkspaceIdx: index("agent_environment_bindings_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);
