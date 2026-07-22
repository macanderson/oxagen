import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ingestionSchema } from "./_schemas";
import {
  appendOnlyAuditMixin,
  citext,
  idMixin,
  orgScopeMixin,
  uuidv7Default,
} from "./_mixins";

// ── ingestion.source_connections ─────────────────────────────────────────────

export const sourceConnections = ingestionSchema.table(
  "source_connections",
  {
    ...idMixin("con"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    workspaceId: uuid("workspace_id").notNull(),
    orgId: uuid("org_id").notNull(),
    connectorId: text("connector_id").notNull(),
    displayName: text("display_name").notNull(),
    authScheme: text("auth_scheme").notNull(),
    deliveryMethod: text("delivery_method").notNull(),
    deliveryConfig: jsonb("delivery_config"),
    status: text("status").notNull().default("pending_setup"),
    entityCount: integer("entity_count").notNull().default(0),
    // Per-source-record-type incremental cursor map: { [sourceRecordType]: cursorValue }.
    // The poll/sync loop reads each record type's cursor before polling and
    // advances it from the batch just fetched (see @oxagen/ingestion/sync).
    cursor: jsonb("cursor"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
    errorMessage: text("error_message"),
    // ── Poll/sync loop health + scheduling (source of truth; §Connector Dual-Write) ──
    // Rolls up the last poll outcome for the UI and self-healing scheduler.
    // healthy = last poll ok; degraded = 1..3 consecutive failures (still
    // polling, data may be stale); errored = 4+ failures (needs attention).
    healthStatus: text("health_status").notNull().default("healthy"),
    // Consecutive poll failures — drives exponential backoff and the health
    // transition. Reset to 0 on any successful poll.
    consecutiveFailureCount: integer("consecutive_failure_count")
      .notNull()
      .default(0),
    // When the connection was last polled (success OR failure).
    lastPollAt: timestamp("last_poll_at", { withTimezone: true, mode: "date" }),
    // When the connection is next due to be polled. The scheduler cron claims
    // connections whose next_poll_at <= now() (or is null). Null = never polled.
    nextPollAt: timestamp("next_poll_at", { withTimezone: true, mode: "date" }),
    // Timestamp of the most recent poll failure (paired with error_message).
    lastErrorAt: timestamp("last_error_at", {
      withTimezone: true,
      mode: "date",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    deletedByUserId: uuid("deleted_by_user_id"),
    oauthAccountId: uuid("oauth_account_id"),
    createdByUserId: uuid("created_by_user_id"),
    updatedByUserId: uuid("updated_by_user_id"),
  },
  (t) => ({
    workspaceOrgIdx: index("source_connections_workspace_org_idx").on(
      t.workspaceId,
      t.orgId,
    ),
    connectorIdx: index("source_connections_connector_idx").on(t.connectorId),
    statusIdx: index("source_connections_status_idx").on(t.status),
    oauthAccountIdx: index("source_connections_oauth_account_idx").on(
      t.oauthAccountId,
    ),
    // Poll-scheduler due-work scan: order live connections by next_poll_at.
    nextPollDueIdx: index("source_connections_next_poll_due_idx").on(
      t.nextPollAt,
    ),
    // Partial variant confined to poll-eligible rows — matches the scheduler's
    // WHERE status = 'connected' AND deleted_at IS NULL predicate exactly, so
    // the due-work scan never touches deleted/paused/errored rows.
    pollDuePartialIdx: index("source_connections_poll_due_partial_idx")
      .on(t.nextPollAt)
      .where(sql`status = 'connected' AND deleted_at IS NULL`),
    // 'deleting' is set synchronously by connection.delete; 'deleted' is the
    // terminal state written by the async purge job (ingestion.delete). Both
    // were missing here, so any delete violated this CHECK → 500 (OXA-1751).
    statusCheck: check(
      "source_connections_status_check",
      sql`${t.status} IN ('pending_setup', 'connected', 'paused', 'error', 'deleting', 'deleted')`,
    ),
    healthStatusCheck: check(
      "source_connections_health_status_check",
      sql`${t.healthStatus} IN ('healthy', 'degraded', 'errored')`,
    ),
  }),
);

// ── ingestion.auth_credentials ───────────────────────────────────────────────

export const authCredentials = ingestionSchema.table("auth_credentials", {
  connectionId: uuid("connection_id").primaryKey(),
  authScheme: text("auth_scheme").notNull(),
  encryptedPayload: jsonb("encrypted_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// ── ingestion.oauth_tokens ────────────────────────────────────────────────────

export const oauthTokens = ingestionSchema.table(
  "oauth_tokens",
  {
    connectionId: uuid("connection_id").primaryKey(),
    accessTokenEnc: jsonb("access_token_enc").notNull(),
    refreshTokenEnc: jsonb("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    tokenType: text("token_type").notNull().default("Bearer"),
    scopes: text("scopes").array().notNull().default(sql`'{}'`),
    providerUserId: text("provider_user_id"),
    providerAccountId: text("provider_account_id"),
    lastRefreshedAt: timestamp("last_refreshed_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index("oauth_tokens_expires_at_idx").on(t.expiresAt),
  }),
);

// ── ingestion.webhook_subscriptions ──────────────────────────────────────────

export const webhookSubscriptions = ingestionSchema.table(
  "webhook_subscriptions",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    webhookPath: text("webhook_path").notNull().unique(),
    secretEnc: jsonb("secret_enc"),
    hmacAlgorithm: text("hmac_algorithm"),
    hmacHeader: text("hmac_header"),
    providerSubscriptionId: text("provider_subscription_id"),
    recordTypes: text("record_types").array().notNull().default(sql`'{}'`),
    status: text("status").notNull().default("active"),
    lastReceivedAt: timestamp("last_received_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Provider subscription expiry (Graph ~3d, Google watch ~7d). The renewal
    // cron (ingestion.webhook-renew) re-subscribes rows nearing this. NULL for
    // providers whose subscriptions do not expire.
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    connectionIdx: index("webhook_subscriptions_connection_idx").on(
      t.connectionId,
    ),
    statusIdx: index("webhook_subscriptions_status_idx").on(t.status),
    // Partial index backing the renewal scan (active + expiring rows only).
    renewalIdx: index("webhook_subscriptions_renewal_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active' AND ${t.expiresAt} IS NOT NULL`),
    // Missing CHECK constraint (2026-07-11 audit §5 item 4). No write path
    // exists yet (§1.6 — feature intent only); this constrains the column to
    // the lifecycle vocabulary the read side (apps/api webhook route) and
    // sibling status columns already use, ahead of provisioning landing.
    statusCheck: check(
      "webhook_subscriptions_status_check",
      sql`${t.status} IN ('active', 'paused', 'revoked', 'error')`,
    ),
  }),
);

// ── ingestion.oauth_accounts ──────────────────────────────────────────────────

export const oauthAccounts = ingestionSchema.table(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    orgId: uuid("org_id").notNull(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    providerUserEmail: text("provider_user_email"),
    providerUserName: text("provider_user_name"),
    accessTokenEnc: jsonb("access_token_enc").notNull(),
    refreshTokenEnc: jsonb("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    tokenType: text("token_type").notNull().default("Bearer"),
    scopes: text("scopes").array().notNull().default(sql`'{}'`),
    lastRefreshedAt: timestamp("last_refreshed_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
  },
  (t) => ({
    orgProviderIdx: index("oauth_accounts_org_provider_idx").on(
      t.orgId,
      t.provider,
    ),
    expiresAtIdx: index("oauth_accounts_expires_at_idx").on(t.expiresAt),
    orgProviderUserUniq: unique("oauth_accounts_org_provider_user_uq").on(
      t.orgId,
      t.provider,
      t.providerUserId,
    ),
  }),
);

// ── ingestion.entity_type_mappings ────────────────────────────────────────────

export const entityTypeMappings = ingestionSchema.table(
  "entity_type_mappings",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    orgId: uuid("org_id").notNull(),
    sourceRecordType: text("source_record_type").notNull(),
    oxagenEntityType: text("oxagen_entity_type").notNull(),
    propertyMappings: jsonb("property_mappings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    connectionIdx: index("entity_type_mappings_connection_idx").on(
      t.connectionId,
    ),
    workspaceTypeIdx: index("entity_type_mappings_workspace_type_idx").on(
      t.workspaceId,
      t.oxagenEntityType,
    ),
    connectionTypeUniq: unique("entity_type_mappings_connection_type_uniq").on(
      t.connectionId,
      t.sourceRecordType,
    ),
  }),
);

// ── ingestion.setup_suggestions ───────────────────────────────────────────────

export const setupSuggestions = ingestionSchema.table(
  "setup_suggestions",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceRecordType: text("source_record_type").notNull(),
    suggestedEntityType: text("suggested_entity_type").notNull(),
    suggestedPropertyMappings: jsonb("suggested_property_mappings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    reasoning: text("reasoning"),
    status: text("status").notNull().default("pending"),
  },
  (t) => ({
    connectionIdx: index("setup_suggestions_connection_idx").on(t.connectionId),
    statusIdx: index("setup_suggestions_status_idx").on(t.status),
    orgIdx: index("setup_suggestions_org_idx").on(t.orgId, t.workspaceId),
    // Missing CHECK constraint (2026-07-11 audit §5 item 4). Only 'pending'
    // is ever written (connection.mappings.suggest.ts); the "so the user can
    // accept/reject them" intent plus the dead resolved_at/resolved_by
    // columns confirm the terminal states.
    statusCheck: check(
      "setup_suggestions_status_check",
      sql`${t.status} IN ('pending', 'accepted', 'rejected')`,
    ),
  }),
);

// ── ingestion.deletion_jobs ────────────────────────────────────────────────────

export const deletionJobs = ingestionSchema.table(
  "deletion_jobs",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    orgId: uuid("org_id").notNull(),
    deleteMode: text("delete_mode").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    totalEntities: integer("total_entities"),
    deletedEntities: integer("deleted_entities").notNull().default(0),
    aliasPromotions: integer("alias_promotions").notNull().default(0),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    error: text("error"),
  },
  (t) => ({
    connectionIdx: index("deletion_jobs_connection_idx").on(t.connectionId),
    workspaceIdx: index("deletion_jobs_workspace_idx").on(t.workspaceId),
    statusIdx: index("deletion_jobs_status_idx").on(t.status),
    statusCheck: check(
      "deletion_jobs_status_check",
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    // Contract modes are connection_only | data_only | full (connection.delete).
    // The old 'soft'/'hard' values were stale, so every deletion job insert
    // violated this CHECK → 500 (OXA-1751).
    deleteModeCheck: check(
      "deletion_jobs_delete_mode_check",
      sql`${t.deleteMode} IN ('connection_only', 'data_only', 'full')`,
    ),
  }),
);

// ── ingestion.connector_schemas ─────────────────────────────────────────────────

export const connectorSchemas = ingestionSchema.table(
  "connector_schemas",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    pluginId: text("plugin_id").notNull(),
    schemaUrl: text("schema_url"),
    schema: jsonb("schema").notNull().default(sql`'{}'::jsonb`),
    schemaVersion: text("schema_version").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pluginIdVersionUniq: unique("connector_schemas_plugin_version_uniq").on(
      t.pluginId,
      t.pluginVersion,
    ),
    pluginIdIdx: index("connector_schemas_plugin_id_idx").on(t.pluginId),
    cachedAtIdx: index("connector_schemas_cached_at_idx").on(t.cachedAt),
  }),
);

// ── ingestion.github_installations ────────────────────────────────────────────
//
// Platform-scoped registry of GitHub App installations — ONE row per GitHub
// account (org or user) the Oxagen App is installed on. A GitHub App
// installation is a SINGLETON per GitHub account: `installation_id` is globally
// unique and belongs to the GitHub account, NOT to whichever Oxagen tenant first
// connected it. Many Oxagen tenants/workspaces legitimately attach to the SAME
// installation (see source_connections.delivery_config.installationId + the App
// webhook's cross-tenant fan-out), which is exactly why a second tenant must be
// able to bind an already-installed org without re-installing.
//
// Deliberately NOT tenant-scoped: like ingestion.connector_schemas this is a
// shared/system catalog (no org_id/workspace_id, no RLS — only oxagen_app
// grants). It is the single source of truth for installation IDENTITY +
// LIFECYCLE (suspend/uninstall) that the App webhook keeps live and the
// connect/attach flow validates against, replacing the fragile
// `delivery_config ->> 'installationId'` JSONB scans.
export const githubInstallations = ingestionSchema.table(
  "github_installations",
  {
    ...idMixin("ghi"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // GitHub's numeric installation id (globally unique per App). Stored as text
    // for parity with delivery_config.installationId (JSON stringifies numbers).
    installationId: text("installation_id").notNull(),
    // The GitHub account the App is installed on.
    accountLogin: text("account_login"),
    accountId: text("account_id"),
    // GitHub's account/target type: "Organization" | "User".
    accountType: text("account_type"),
    // Public slug of the GitHub App (github.com/apps/<slug>).
    appSlug: text("app_slug"),
    // "all" | "selected" — which repos the installation grants access to.
    repositorySelection: text("repository_selection"),
    // Lifecycle, maintained by the App webhook (installation +
    // installation_repositories events). A suspended or uninstalled installation
    // cannot mint tokens, so its connections are paused. deleted_at =
    // uninstalled (soft-close: keeps history and lets a re-install reactivate
    // rather than orphan the row).
    suspendedAt: timestamp("suspended_at", {
      withTimezone: true,
      mode: "date",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // One registry row per GitHub installation — the identity uniqueness the
    // JSONB-in-delivery_config model never had.
    installationIdUniq: unique("github_installations_installation_id_uq").on(
      t.installationId,
    ),
    accountLoginIdx: index("github_installations_account_login_idx").on(
      t.accountLogin,
    ),
  }),
);

// ── Governed repository bindings (docs/specs/run-evidence-ingress) ───────────
//
// The trusted repository identity a governed agent run is admitted against.
// This exists because `source_connections.delivery_config` is a mutable JSONB
// bag: reading repository identity from it means a rename or a reconfigured
// default ref silently changes what an already-admitted run claims it saw.
//
// A binding is IMMUTABLE and VERSIONED. A rename or default-ref reconfiguration
// INSERTS a new version pointing at the one it supersedes; it never edits an
// admitted binding. `provider_repository_id` is the provider's own immutable
// numeric/opaque id — the only field that survives a rename, which is why
// identity keys on it rather than on owner/name.
export const repositoryBindings = ingestionSchema.table(
  "repository_bindings",
  {
    ...idMixin("rpb"),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull(),
    // Immutable across renames (e.g. GitHub's numeric repository id).
    providerRepositoryId: text("provider_repository_id").notNull(),
    // What the provider reported at `observed_at` — annotations, not identity.
    providerOwner: text("provider_owner").notNull(),
    providerName: text("provider_name").notNull(),
    providerFullName: text("provider_full_name").notNull(),
    // The EXACT configured default ref. Admission never falls back to the
    // string "main" (spec.md §"Launch changes", item 2).
    configuredDefaultRef: text("configured_default_ref").notNull(),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").notNull(),
    supersedesBindingId: uuid("supersedes_binding_id"),
  },
  (t) => ({
    repositoryVersionUniq: uniqueIndex(
      "repository_bindings_repository_version_uq",
    ).on(t.connectionId, t.providerRepositoryId, t.version),
    orgIdx: index("repository_bindings_org_idx").on(t.orgId, t.workspaceId),
    connectionIdx: index("repository_bindings_connection_idx").on(
      t.connectionId,
    ),
    versionCheck: check(
      "repository_bindings_version_check",
      sql`${t.version} > 0`,
    ),
    // Version 1 supersedes nothing; every later version must name its parent,
    // so the chain back to the first observation is never broken.
    supersedesCheck: check(
      "repository_bindings_supersedes_check",
      sql`(${t.version} = 1 AND ${t.supersedesBindingId} IS NULL) OR (${t.version} > 1 AND ${t.supersedesBindingId} IS NOT NULL)`,
    ),
    supersedesSelfCheck: check(
      "repository_bindings_supersedes_self_check",
      sql`${t.supersedesBindingId} IS NULL OR ${t.supersedesBindingId} <> ${t.id}`,
    ),
    // The configured default ref must be a real ref, never an empty string that
    // would read as "unset" and invite a fallback.
    defaultRefCheck: check(
      "repository_bindings_default_ref_check",
      sql`length(${t.configuredDefaultRef}) > 0`,
    ),
  }),
);

// ── Mutable head pointer per (connection, provider repository) ───────────────
//
// Which binding VERSION is current for one repository. Mutable on purpose: it
// is a pointer, not evidence. Admission reads the head to resolve, then copies
// the resolved binding's identity into the immutable run row — so advancing the
// head afterwards can never rewrite what an admitted run claims.
export const repositoryBindingHeads = ingestionSchema.table(
  "repository_binding_heads",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull(),
    providerRepositoryId: text("provider_repository_id").notNull(),
    currentBindingId: uuid("current_binding_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    repositoryUniq: uniqueIndex("repository_binding_heads_repository_uq").on(
      t.connectionId,
      t.providerRepositoryId,
    ),
    orgIdx: index("repository_binding_heads_org_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

// ── Explicit primary-repository selection per governed connection ────────────
//
// Security admission follows THIS pointer and never infers repository identity
// from `delivery_config`. The unique key is the connection, so a connection
// with several repositories and no explicit selection has no row and admission
// FAILS CLOSED rather than guessing which repository the agent may edit.
export const governedRepositorySelections = ingestionSchema.table(
  "governed_repository_selections",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    connectionId: uuid("connection_id").notNull(),
    primaryBindingId: uuid("primary_binding_id").notNull(),
    selectedByUserId: uuid("selected_by_user_id"),
    selectedAt: timestamp("selected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Exactly one current primary binding per governed connection.
    connectionUniq: uniqueIndex(
      "governed_repository_selections_connection_uq",
    ).on(t.connectionId),
    orgIdx: index("governed_repository_selections_org_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

export type RepositoryBinding = typeof repositoryBindings.$inferSelect;
export type NewRepositoryBinding = typeof repositoryBindings.$inferInsert;
export type RepositoryBindingHead = typeof repositoryBindingHeads.$inferSelect;
export type GovernedRepositorySelection =
  typeof governedRepositorySelections.$inferSelect;
