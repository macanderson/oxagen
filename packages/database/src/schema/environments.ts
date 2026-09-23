/**
 * environments — Agent Environments & Credential Vault (Spec:
 * docs/superpowers/specs/2026-06-24-credential-vault-environments-sandboxes-spec.md §5).
 *
 * Phase 0 ("Vault + Environments core", §18) shipped four tables; §5.6 binds
 * an agent to one of them. The sandbox-template tables (§5.2–§5.3) were
 * dropped with the agent runtime in ADR-043 — Oxagen governs agents, it does
 * not run them, so it has no sandbox to configure.
 *
 * Tables:
 *   §5.1  environments               (env_…) — one is_default per workspace; seeded "default"
 *   §5.4  secret_keys                (sk_…)  — vault root: key + sensitive flag + default value
 *   §5.5  secret_values              (sv_…)  — per-(key, environment) overrides
 *   §5.7  secret_access_log                  — append-only audit for reveal/export (§7.3)
 *   §5.6  agent_environment_bindings (aeb_…) — agent → environment; one is_primary per agent
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

// ── §5.6 environments.agent_environment_bindings ─────────────────────────────
// Binds an agent to an environment. Exactly one binding per agent carries
// is_primary=true (DB partial-unique + handler guard) — the one used when a run
// doesn't name an environment. Bindings stay OUT of agent_versions.config
// (mutable operational config). The sandbox-template half of this binding went
// with environments.sandbox_templates in ADR-043.

export const agentEnvironmentBindings = environmentsSchema.table(
  "agent_environment_bindings",
  {
    ...idMixin("aeb"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // App-enforced FKs (no .references() — cross-schema pattern).
    agentId: uuid("agent_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
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
