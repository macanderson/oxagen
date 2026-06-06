import { sql } from "drizzle-orm";
import {
  boolean,
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
 * mcp.registries — registry sources an org can sync from. A row with a NULL
 * org_id is a global default seed visible to every org (the official MCP
 * registry is seeded this way in migration 0007).
 */
export const mcpRegistries = mcpSchema.table(
  "registries",
  {
    ...idMixin("mreg"),
    ...auditMixin(),
    orgId: uuid("org_id"), // NULL ⇒ global default seed
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    isDefaultSeed: boolean("is_default_seed").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    lastSyncedCursor: text("last_synced_cursor"),
  },
  (t) => ({
    orgIdx: index("registries_org_idx").on(t.orgId),
  }),
);

/**
 * mcp.catalog_servers — cached registry records. One row per
 * (registry_id, name, version); is_latest is maintained on upsert.
 * Heterogeneous registry payloads (repository/icons/packages/remotes/meta)
 * are stored as JSONB; transport_types/categories are denormalized arrays for
 * cheap filtering.
 */
export const mcpCatalogServers = mcpSchema.table(
  "catalog_servers",
  {
    ...idMixin("mcat"),
    ...auditMixin(),
    registryId: uuid("registry_id").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    isLatest: boolean("is_latest").notNull().default(false),
    title: text("title"),
    description: text("description").notNull(),
    repository: jsonb("repository"),
    websiteUrl: text("website_url"),
    icons: jsonb("icons").notNull().default(sql`'[]'::jsonb`),
    packages: jsonb("packages").notNull().default(sql`'[]'::jsonb`),
    remotes: jsonb("remotes").notNull().default(sql`'[]'::jsonb`),
    transportTypes: text("transport_types").array().notNull().default(sql`'{}'::text[]`),
    authKind: text("auth_kind").notNull(),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    readmeHtml: text("readme_html"),
    readmeFetchedAt: timestamp("readme_fetched_at", { withTimezone: true, mode: "date" }),
    status: text("status").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    upstreamUpdatedAt: timestamp("upstream_updated_at", { withTimezone: true, mode: "date" }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true, mode: "date" }),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    uniqueVersion: uniqueIndex("catalog_servers_name_version_uniq").on(
      t.registryId,
      t.name,
      t.version,
    ),
    registryNameIdx: index("catalog_servers_registry_name_idx").on(t.registryId, t.name),
  }),
);

/**
 * mcp.credentials — SOC2-encrypted auth per (org_listing × workspace).
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
  }),
);
