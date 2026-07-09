import { boolean, check, index, integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ingestionSchema } from "./_schemas";
import { citext, idMixin, uuidv7Default } from "./_mixins";

// ── ingestion.source_connections ─────────────────────────────────────────────

export const sourceConnections = ingestionSchema.table(
  "source_connections",
  {
    ...idMixin("con"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
    // When the connection was last polled (success OR failure).
    lastPollAt: timestamp("last_poll_at", { withTimezone: true, mode: "date" }),
    // When the connection is next due to be polled. The scheduler cron claims
    // connections whose next_poll_at <= now() (or is null). Null = never polled.
    nextPollAt: timestamp("next_poll_at", { withTimezone: true, mode: "date" }),
    // Timestamp of the most recent poll failure (paired with error_message).
    lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    deletedByUserId: uuid("deleted_by_user_id"),
    oauthAccountId: uuid("oauth_account_id"),
    createdByUserId: uuid("created_by_user_id"),
    updatedByUserId: uuid("updated_by_user_id"),
  },
  (t) => ({
    workspaceOrgIdx: index("source_connections_workspace_org_idx").on(t.workspaceId, t.orgId),
    connectorIdx: index("source_connections_connector_idx").on(t.connectorId),
    statusIdx: index("source_connections_status_idx").on(t.status),
    oauthAccountIdx: index("source_connections_oauth_account_idx").on(t.oauthAccountId),
    // Poll-scheduler due-work scan: order live connections by next_poll_at.
    nextPollDueIdx: index("source_connections_next_poll_due_idx").on(t.nextPollAt),
    // 'deleting' is set synchronously by connection.delete; 'deleted' is the
    // terminal state written by the async purge job (ingestion.delete). Both
    // were missing here, so any delete violated this CHECK → 500 (OXA-1751).
    statusCheck: check("source_connections_status_check", sql`${t.status} IN ('pending_setup', 'connected', 'paused', 'error', 'deleting', 'deleted')`),
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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true, mode: "date" }),
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    webhookPath: text("webhook_path").notNull().unique(),
    secretEnc: jsonb("secret_enc"),
    hmacAlgorithm: text("hmac_algorithm"),
    hmacHeader: text("hmac_header"),
    providerSubscriptionId: text("provider_subscription_id"),
    recordTypes: text("record_types").array().notNull().default(sql`'{}'`),
    status: text("status").notNull().default("active"),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    connectionIdx: index("webhook_subscriptions_connection_idx").on(t.connectionId),
    statusIdx: index("webhook_subscriptions_status_idx").on(t.status),
  }),
);

// ── ingestion.oauth_accounts ──────────────────────────────────────────────────

export const oauthAccounts = ingestionSchema.table(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true, mode: "date" }),
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
  },
  (t) => ({
    orgProviderIdx: index("oauth_accounts_org_provider_idx").on(t.orgId, t.provider),
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    orgId: uuid("org_id").notNull(),
    sourceRecordType: text("source_record_type").notNull(),
    oxagenEntityType: text("oxagen_entity_type").notNull(),
    propertyMappings: jsonb("property_mappings").notNull().default(sql`'{}'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    connectionIdx: index("entity_type_mappings_connection_idx").on(t.connectionId),
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedBy: uuid("resolved_by"),
  },
  (t) => ({
    connectionIdx: index("setup_suggestions_connection_idx").on(t.connectionId),
    statusIdx: index("setup_suggestions_status_idx").on(t.status),
    orgIdx: index("setup_suggestions_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// ── ingestion.deletion_jobs ────────────────────────────────────────────────────

export const deletionJobs = ingestionSchema.table(
  "deletion_jobs",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    publicId: citext("public_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    orgId: uuid("org_id").notNull(),
    deleteMode: text("delete_mode").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    totalEntities: integer("total_entities"),
    deletedEntities: integer("deleted_entities").notNull().default(0),
    aliasPromotions: integer("alias_promotions").notNull().default(0),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    error: text("error"),
  },
  (t) => ({
    connectionIdx: index("deletion_jobs_connection_idx").on(t.connectionId),
    workspaceIdx: index("deletion_jobs_workspace_idx").on(t.workspaceId),
    statusIdx: index("deletion_jobs_status_idx").on(t.status),
    statusCheck: check("deletion_jobs_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`),
    // Contract modes are connection_only | data_only | full (connection.delete).
    // The old 'soft'/'hard' values were stale, so every deletion job insert
    // violated this CHECK → 500 (OXA-1751).
    deleteModeCheck: check("deletion_jobs_delete_mode_check", sql`${t.deleteMode} IN ('connection_only', 'data_only', 'full')`),
  }),
);

// ── ingestion.connector_schemas ─────────────────────────────────────────────────

export const connectorSchemas = ingestionSchema.table(
  "connector_schemas",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    pluginId: text("plugin_id").notNull(),
    schemaUrl: text("schema_url"),
    schema: jsonb("schema").notNull().default(sql`'{}'::jsonb`),
    schemaVersion: text("schema_version").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
