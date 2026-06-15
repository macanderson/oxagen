import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pluginSchema } from "./_schemas";
import { auditMixin, idMixin, softDeleteMixin } from "./_mixins";

/** The four installable plugin types. The discriminator stored in
 *  plugin.org_listings.plugin_type and used by the runtime PluginType registry. */
export const PLUGIN_TYPES = ["mcp_server", "integration", "content_tool", "capability"] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];

/**
 * plugin.org_listings — the org allow-list. Polymorphic across plugin types
 * (mcp_server | integration | content_tool | capability). A row with catalog_server_id set
 * came from a registry; NULL means a custom admin-added plugin. Newly added
 * listings are disabled by default but available to all child workspaces.
 */
export const pluginOrgListings = pluginSchema.table(
  "org_listings",
  {
    ...idMixin("porg"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id"),
    pluginType: text("plugin_type").notNull(), // mcp_server | integration | content_tool | capability
    catalogServerId: uuid("catalog_server_id"), // NULL ⇒ custom
    source: text("source").notNull(), // registry | custom | oxagen
    name: text("name").notNull(),
    title: text("title"),
    description: text("description"),
    iconUrl: text("icon_url"),
    endpointUrl: text("endpoint_url"),
    transport: text("transport"),
    authKind: text("auth_kind").notNull(), // oauth | secret | none
    authConfig: jsonb("auth_config").notNull().default(sql`'{}'::jsonb`),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    uniqueName: uniqueIndex("org_listings_org_ws_type_name_uniq").on(
      t.orgId,
      t.workspaceId,
      t.pluginType,
      t.name,
    ),
    orgTypeIdx: index("org_listings_org_ws_type_idx").on(t.orgId, t.workspaceId, t.pluginType),
    typeCheck: check(
      "org_listings_type_check",
      sql`${t.pluginType} IN ('mcp_server','integration','content_tool','capability')`,
    ),
    sourceCheck: check(
      "org_listings_source_check",
      sql`${t.source} IN ('registry','custom','oxagen')`,
    ),
    authKindCheck: check(
      "org_listings_auth_kind_check",
      sql`${t.authKind} IN ('oauth','secret','none')`,
    ),
  }),
);

/**
 * plugin.org_denylist — servers an org admin has blocked. A denylisted name is
 * non-installable; the marketplace still shows it with a disabled/denied
 * treatment. Adding a denylist row disables any existing listing/install for
 * that name (enforced in the handler, Plan 3).
 */
export const pluginOrgDenylist = pluginSchema.table(
  "org_denylist",
  {
    ...idMixin("pden"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    pluginType: text("plugin_type").notNull(),
    serverName: text("server_name").notNull(),
    reason: text("reason"),
  },
  (t) => ({
    uniqueName: uniqueIndex("org_denylist_org_type_name_uniq").on(
      t.orgId,
      t.pluginType,
      t.serverName,
    ),
    typeCheck: check(
      "org_denylist_type_check",
      sql`${t.pluginType} IN ('mcp_server','integration','content_tool','capability')`,
    ),
  }),
);
