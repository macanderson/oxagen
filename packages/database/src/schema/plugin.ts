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

/** The six installable plugin types. The discriminator stored in
 *  plugin.installed_plugins.plugin_type and used by the runtime PluginType
 *  registry. `mcp_server_local` is the local-file MCP runtime type
 *  (packages/agent/.../file-mcp.ts); the live installed_plugins CHECK accepts
 *  it, so this list and the DB constraint below agree. */
export const PLUGIN_TYPES = [
  "agent_skill",
  "agent_capability",
  "mcp_server",
  "mcp_server_local",
  "knowledge_source",
  "integration",
] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];

/**
 * plugin.installed_plugins — the org+workspace allow-list. Polymorphic across
 * the six PLUGIN_TYPES above. workspace_id is always required; org-level
 * defaults are represented by a sentinel workspace id at the handler layer.
 *
 * An installed plugin carries its own name/title/description/url inline; there
 * is no registry cache to join against, and `source` records the origin
 * ('registry' | 'custom' | 'oxagen').
 */
export const pluginInstalledPlugins = pluginSchema.table(
  "installed_plugins",
  {
    ...idMixin("porg"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    pluginType: text("plugin_type").notNull(), // agent_skill | agent_capability | mcp_server | knowledge_source | integration
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
    uniqueName: uniqueIndex("installed_plugins_org_ws_type_name_uniq").on(
      t.orgId,
      t.workspaceId,
      t.pluginType,
      t.name,
    ),
    orgTypeIdx: index("installed_plugins_org_ws_type_idx").on(
      t.orgId,
      t.workspaceId,
      t.pluginType,
    ),
    typeCheck: check(
      "installed_plugins_type_check",
      sql`${t.pluginType} IN ('agent_skill','agent_capability','mcp_server','mcp_server_local','knowledge_source','integration')`,
    ),
    sourceCheck: check(
      "installed_plugins_source_check",
      sql`${t.source} IN ('registry','custom','oxagen')`,
    ),
    authKindCheck: check(
      "installed_plugins_auth_kind_check",
      sql`${t.authKind} IN ('oauth','secret','none')`,
    ),
  }),
);
