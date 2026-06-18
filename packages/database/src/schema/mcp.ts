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
import { auditMixin, bytea, idMixin, orgScopeMixin } from "./_mixins";

/**
 * mcp.registries — registry sources an org+workspace can use. Every row is now
 * scoped to an org AND workspace; the `is_default` flag identifies the workspace's
 * default registry (enforced via partial unique index in the SQL migration).
 *
 * The `is_default_seed`, `last_synced_at`, and `last_synced_cursor` columns were
 * removed in the workspace-scoping rebuild (2026-06-17) — the catalog sync
 * machinery is gone; the marketplace queries installed_plugins directly.
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
  },
  (t) => ({
    orgIdx: index("registries_org_idx").on(t.orgId, t.workspaceId),
    // Composite unique: one registry URL per org+workspace.
    urlUniq: uniqueIndex("registries_org_ws_url_uniq").on(t.orgId, t.workspaceId, t.baseUrl),
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
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    uniqueListingWs: uniqueIndex("credentials_workspace_listing_uniq").on(
      t.workspaceId,
      t.orgListingId,
    ),
    orgIdx: index("credentials_org_idx").on(t.orgId),
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
    lastHealthcheckAt: timestamp("last_healthcheck_at", { withTimezone: true, mode: "date" }),
    discoveredTools: jsonb("discovered_tools").notNull().default(sql`'[]'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => ({
    orgIdx: index("mcp_servers_org_idx").on(t.orgId, t.workspaceId),
    enabledIdx: index("mcp_servers_enabled_idx").on(t.workspaceId, t.enabled),
    wsListingUniq: uniqueIndex("mcp_servers_ws_listing_uniq")
      .on(t.workspaceId, t.orgListingId)
      .where(sql`org_listing_id IS NOT NULL`),
  }),
);
