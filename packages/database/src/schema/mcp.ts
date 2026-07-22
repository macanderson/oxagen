import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mcpSchema } from "./_schemas";
import {
  auditMixin,
  bytea,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
} from "./_mixins";

/**
 * mcp.registries — registry sources an org+workspace can use. Every row is now
 * scoped to an org AND workspace; the `is_default` flag identifies the workspace's
 * default registry (enforced via partial unique index in the SQL migration).
 *
 * The `is_default_seed` column was removed in the workspace-scoping rebuild
 * (2026-06-17). `last_synced_at` and `last_synced_cursor` are NOT dead — they
 * remain live: the catalog sync loop (packages/plugins/src/catalog-sync.ts)
 * writes them, and the marketplace browse handler
 * (packages/handlers/src/plugin.catalog.browse.ts) reads them to drive
 * incremental registry sync.
 *
 * The partial unique `UNIQUE (org_id, workspace_id) WHERE is_default` index is
 * expressed in the Atlas SQL migration (Task 2) via:
 *   CREATE UNIQUE INDEX ... WHERE is_default = true;
 * Drizzle's `uniqueIndex(...).where(sql\`is_default\`)` is also added below to
 * keep the Drizzle schema self-documenting (mirrors how mcpServers.wsListingUniq
 * uses `.where(sql\`...\`)`).
 */
export const mcpRegistries = mcpSchema.table(
  "registries",
  {
    ...idMixin("mreg"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    /** When the catalog was last synced from this registry. Null = never synced. */
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Cursor for incremental sync — resume from this position next sync. */
    lastSyncedCursor: text("last_synced_cursor"),
  },
  (t) => ({
    orgIdx: index("registries_org_idx").on(t.orgId, t.workspaceId),
    // Composite unique: one registry URL per org+workspace.
    urlUniq: uniqueIndex("registries_org_ws_url_uniq").on(
      t.orgId,
      t.workspaceId,
      t.baseUrl,
    ),
    // Partial unique: at most one default registry per org+workspace.
    // The SQL migration creates this as a real partial unique index; Drizzle
    // expresses the WHERE predicate via .where() mirroring mcpServers.wsListingUniq.
    defaultUniq: uniqueIndex("registries_org_ws_default_uniq")
      .on(t.orgId, t.workspaceId)
      .where(sql`is_default`),
  }),
);

/**
 * mcp.credentials — SOC2-encrypted auth per (installed_plugin × workspace).
 * Token columns are envelope-encrypted bytea (AES-256-GCM); the service layer
 * (@oxagen/plugins/credentials) is responsible for encrypt/decrypt. Org-level
 * shared credentials use the ORG_ONLY_WS sentinel workspace id.
 */
export const mcpCredentials = mcpSchema.table(
  "credentials",
  {
    ...idMixin("mcrd"),
    ...auditMixin(),
    ...orgScopeMixin(),
    orgListingId: uuid("org_listing_id").notNull(),
    authKind: text("auth_kind").notNull(), // oauth | secret
    accessTokenEnc: bytea("access_token_enc"),
    refreshTokenEnc: bytea("refresh_token_enc"),
    secretEnc: bytea("secret_enc"),
    oauthClientSecretEnc: bytea("oauth_client_secret_enc"),
    tokenKmsKeyId: text("token_kms_key_id"),
    oauthClientId: text("oauth_client_id"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    status: text("status").notNull().default("active"), // active | needs_reauth | revoked
    lastRefreshedAt: timestamp("last_refreshed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    uniqueListingWs: uniqueIndex("credentials_workspace_listing_uniq").on(
      t.workspaceId,
      t.orgListingId,
    ),
    orgIdx: index("credentials_org_idx").on(t.orgId),
    // OAuth refresh watcher: a 30-min cross-tenant cron scans for expiring
    // OAuth credentials with no covering index today (2026-07-11 audit
    // §4.1 item 3).
    oauthExpiringIdx: index("credentials_oauth_expiring_idx")
      .on(t.expiresAt)
      .where(sql`${t.authKind} = 'oauth' AND ${t.status} = 'active'`),
    authKindCheck: check(
      "credentials_auth_kind_check",
      sql`${t.authKind} IN ('oauth','secret')`,
    ),
    statusCheck: check(
      "credentials_status_check",
      sql`${t.status} IN ('active','needs_reauth','revoked')`,
    ),
  }),
);

/**
 * mcp.mcp_servers — installed MCP server instances per org/workspace.
 * Moved from agent.ts so all MCP-protocol artefacts share one domain schema.
 */
export const mcpServers = mcpSchema.table(
  "mcp_servers",
  {
    ...idMixin("mcs"),
    ...auditMixin(),
    // Soft-delete (OXA-820): deleting a server stops tool registration but
    // retains tool-descriptor snapshots >= 365 days for replay durability. The
    // retention Inngest job keys off deleted_at to purge old snapshots.
    ...softDeleteMixin(),
    ...orgScopeMixin(),
    // Links back to plugin.installed_plugins — nullable because column was added to an existing
    // table; the plugin install handler requires it on every new insert.
    orgListingId: uuid("org_listing_id"),
    name: text("name").notNull(),
    transportType: text("transport_type").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    authStrategy: text("auth_strategy").notNull(),
    authConfig: jsonb("auth_config").notNull().default(sql`'{}'::jsonb`),
    healthStatus: text("health_status").notNull(),
    lastHealthcheckAt: timestamp("last_healthcheck_at", {
      withTimezone: true,
      mode: "date",
    }),
    discoveredTools: jsonb("discovered_tools")
      .notNull()
      .default(sql`'[]'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => ({
    orgIdx: index("mcp_servers_org_idx").on(t.orgId, t.workspaceId),
    enabledIdx: index("mcp_servers_enabled_idx").on(t.workspaceId, t.enabled),
    wsListingUniq: uniqueIndex("mcp_servers_ws_listing_uniq")
      .on(t.workspaceId, t.orgListingId)
      .where(sql`org_listing_id IS NOT NULL`),
    // Missing CHECK constraints on enum-shaped text (2026-07-11 audit §5
    // item 4). Value sets confirmed against live write paths:
    //   healthStatus  — agent.mcp.set_enabled.ts, plugin.set_enabled.ts,
    //                    the oauth/callback route.
    //   transportType — the agent.mcp.register/list contracts only declare
    //                    'streamable-http' | 'stdio', but the "connect a
    //                    custom MCP server" flow (mcp-actions.ts ->
    //                    plugin.org.install -> plugin.set_enabled.ts) also
    //                    writes 'sse' — the UI explicitly offers SSE, so it
    //                    MUST be included or that flow starts throwing.
    //   authStrategy  — agent.mcp.resolve.ts / plugin-types/mcp.ts /
    //                    file-mcp.ts.
    healthStatusCheck: check(
      "mcp_servers_health_status_check",
      sql`${t.healthStatus} IN ('healthy', 'degraded', 'unreachable', 'unknown')`,
    ),
    transportTypeCheck: check(
      "mcp_servers_transport_type_check",
      sql`${t.transportType} IN ('streamable-http', 'sse', 'stdio')`,
    ),
    authStrategyCheck: check(
      "mcp_servers_auth_strategy_check",
      sql`${t.authStrategy} IN ('none', 'bearer', 'header')`,
    ),
  }),
);

/**
 * mcp.consents — first-use consent + scope grants for external MCP tools
 * (OXA-816). The FIRST time an agent invokes a `mcp.<serverId>.<tool>` for a
 * given workspace+user+server+tool, the runtime pauses and renders a consent
 * card; the user's approve/deny lands here. Subsequent calls within the TTL
 * (expires_at) run inline without pausing.
 *
 * Pre-grant: a workspace policy may seed a tool-group grant with
 * tool_name = '*' (the wildcard), which the runtime honours for every tool on
 * that server without a per-tool card.
 *
 * Scope: orgScopeMixin (org_id + workspace_id NOT NULL) so it is a `standard`
 * tenant-owned table in the RLS manifest. user_id makes each grant
 * per-(workspace,user,server,tool) — different users on the same workspace
 * consent independently.
 *
 * Consent SUBJECT (Agent RBAC Phase 4a, spec §3.7): subject_kind
 * discriminates WHO the consent is scoped to. 'user' (the default, and every
 * pre-existing row) keeps the original semantics — user_id is a human user
 * id. 'agent' rows record an AGENT-scoped consent created when a role's
 * resourceScope.mcp rule resolves "ask" for a tool: user_id then holds the
 * agent PRINCIPAL id (iam principals uuid), so agent consents are labeled
 * distinctly from user consents and never collide (user ids and principal
 * ids live in disjoint uuid spaces, which is also why the pre-existing
 * (workspace,user,server,tool) unique key stays sufficient without
 * subject_kind in it).
 */
export const mcpConsents = mcpSchema.table(
  "consents",
  {
    ...idMixin("mcons"),
    ...auditMixin(),
    ...orgScopeMixin(),
    userId: uuid("user_id").notNull(),
    /** Consent subject discriminator: 'user' (user_id = human user id) |
     *  'agent' (user_id = agent principal id). */
    subjectKind: text("subject_kind").notNull().default("user"),
    mcpServerId: uuid("mcp_server_id").notNull(),
    // '*' is the wildcard pre-grant covering every tool on the server.
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(), // granted | denied
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }),
    deniedAt: timestamp("denied_at", { withTimezone: true, mode: "date" }),
    // Grant TTL. NULL = never expires (workspace pre-grants); non-NULL =
    // first-use grant that must be re-confirmed after expiry.
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // One consent row per (workspace, user, server, tool). The runtime upserts
    // on this key when a decision lands.
    consentUniq: uniqueIndex("consents_ws_user_server_tool_uniq").on(
      t.workspaceId,
      t.userId,
      t.mcpServerId,
      t.toolName,
    ),
    // Lookup path used by checkConsent: scope by workspace+user+server.
    lookupIdx: index("consents_lookup_idx").on(
      t.workspaceId,
      t.userId,
      t.mcpServerId,
    ),
    statusCheck: check(
      "consents_status_check",
      sql`${t.status} IN ('granted','denied')`,
    ),
    subjectKindCheck: check(
      "consents_subject_kind_check",
      sql`${t.subjectKind} IN ('user','agent')`,
    ),
  }),
);

/**
 * mcp.catalog_servers — locally-synced registry server entries for instant
 * marketplace browse. Populated by the plugin.catalog-sync Inngest cron job
 * (every 6 hours) and on-demand via the plugin.catalog.sync capability.
 *
 * This table eliminates the live-fetch dependency on registry.modelcontextprotocol.io
 * for the marketplace browse page. The browse handler reads from here when no
 * search query is provided, giving instant results on page load.
 *
 * Scope: per-registry (the registryId links to mcp.registries which is workspace-scoped).
 * Uniqueness: (registry_id, name, version) — one row per server version per registry.
 */
export const mcpCatalogServers = mcpSchema.table(
  "catalog_servers",
  {
    ...idMixin("mcat"),
    ...auditMixin(),
    registryId: uuid("registry_id").notNull(),
    /** Server name as published in the registry (e.g. "github/github-mcp-server"). */
    name: text("name").notNull(),
    version: text("version").notNull(),
    isLatest: boolean("is_latest").notNull().default(false),
    title: text("title"),
    description: text("description").notNull(),
    /** Icon entries as JSON — matches the SHARED ICON DATA CONTRACT. */
    icons: jsonb("icons").notNull().default(sql`'[]'::jsonb`),
    /** Local package install descriptors from the registry. */
    packages: jsonb("packages").notNull().default(sql`'[]'::jsonb`),
    /** Remote transport descriptors (hosted endpoints). */
    remotes: jsonb("remotes").notNull().default(sql`'[]'::jsonb`),
    /** Derived transport types (e.g. ["streamable-http", "stdio"]). */
    transportTypes: text("transport_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Derived auth kind: oauth | secret | none. */
    authKind: text("auth_kind").notNull().default("none"),
    /** Repository URL (optional). */
    repositoryUrl: text("repository_url"),
    /** Website URL (optional). */
    websiteUrl: text("website_url"),
    /** Registry-managed status: active | deprecated | deleted. */
    status: text("status").notNull().default("active"),
    /** When this entry was published in the registry. */
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** When the registry last updated this entry's metadata. */
    upstreamUpdatedAt: timestamp("upstream_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** When this row was last synced from the upstream registry. */
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Unique: one row per (registry, server name, version).
    registryNameVersionUniq: uniqueIndex(
      "catalog_servers_registry_name_version_uniq",
    ).on(t.registryId, t.name, t.version),
    // Browse query: latest entries for a registry, ordered by name.
    browseIdx: index("catalog_servers_browse_idx").on(
      t.registryId,
      t.isLatest,
      t.name,
    ),
    // Full-text search on name + title + description (GIN trigram).
    // Created as a raw SQL index in the migration for pg_trgm support.
    // Missing CHECK constraints (2026-07-11 audit §5 item 4): status and
    // auth_kind were documented in column comments above ("Registry-managed
    // status: active | deprecated | deleted"; "Derived auth kind: oauth |
    // secret | none" — same vocabulary as mcp_servers.auth_strategy's
    // oauth|secret arm) but never enforced.
    statusCheck: check(
      "catalog_servers_status_check",
      sql`${t.status} IN ('active', 'deprecated', 'deleted')`,
    ),
    authKindCheck: check(
      "catalog_servers_auth_kind_check",
      sql`${t.authKind} IN ('oauth', 'secret', 'none')`,
    ),
  }),
);

/**
 * mcp.tool_snapshots — descriptor snapshots for external MCP tools (OXA-820).
 * Each external tool's JSONSchema descriptor is captured at registration (and
 * on re-enable) so replay of an old run can render the tool even after the
 * server is disabled or soft-deleted. Disabling a server stops registration
 * but keeps the snapshots; snapshots are retained >= 365 days after a server is
 * deleted (purged by the mcp.tool-snapshot-retention Inngest cron).
 *
 * Scope: orgScopeMixin so it is a `standard` tenant-owned table in the RLS
 * manifest. captured_at is the version axis — the newest snapshot for a
 * (server, tool) is the live descriptor; older rows preserve replay fidelity.
 */
export const mcpToolSnapshots = mcpSchema.table(
  "tool_snapshots",
  {
    ...idMixin("mtsnap"),
    ...auditMixin(),
    ...orgScopeMixin(),
    mcpServerId: uuid("mcp_server_id").notNull(),
    toolName: text("tool_name").notNull(),
    // The raw JSONSchema descriptor captured from the MCP server's listTools().
    schemaJson: jsonb("schema_json").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Replay lookup: "give me the descriptor for (server, tool) as captured
    // most recently" — ordered scan on captured_at.
    replayIdx: index("tool_snapshots_replay_idx").on(
      t.mcpServerId,
      t.toolName,
      t.capturedAt,
    ),
  }),
);
