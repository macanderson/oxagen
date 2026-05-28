import { boolean, index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas.js";
import {
  auditMixin,
  citext,
  idMixin,
  jsonContractMixin,
  softDeleteMixin,
  tenantScopeMixin,
  versionMixin,
} from "./_mixins.js";

export const agents = agentSchema.table(
  "agents",
  {
    ...idMixin("agt"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
    defaultModel: text("default_model").notNull(),
    isSystemAgent: boolean("is_system_agent").notNull().default(false),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("agents_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantIdx: index("agents_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);

export const agentVersions = agentSchema.table(
  "agent_versions",
  {
    ...idMixin("agv"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    ...versionMixin(),
    ...jsonContractMixin(),
    agentId: uuid("agent_id").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    model: text("model").notNull(),
    temperature: numeric("temperature", { precision: 3, scale: 2 }).notNull(),
    contextWindow: integer("context_window"),
    toolChoicePolicy: text("tool_choice_policy").notNull(),
    runtimeConfig: jsonb("runtime_config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    agentIdx: index("agent_versions_agent_idx").on(t.agentId),
    agentLatestIdx: uniqueIndex("agent_versions_agent_latest_idx")
      .on(t.agentId)
      .where(sql`is_latest = true`),
    agentVersionIdx: uniqueIndex("agent_versions_agent_version_idx").on(t.agentId, t.versionNumber),
    tenantIdx: index("agent_versions_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);

export const tools = agentSchema.table(
  "tools",
  {
    ...idMixin("tol"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    toolType: text("tool_type").notNull(),
    description: text("description").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("tools_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantIdx: index("tools_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);

export const toolVersions = agentSchema.table(
  "tool_versions",
  {
    ...idMixin("tav"),
    ...auditMixin(),
    ...versionMixin(),
    toolId: uuid("tool_id").notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    outputSchema: jsonb("output_schema").notNull(),
    runtimeConfig: jsonb("runtime_config").notNull().default(sql`'{}'::jsonb`),
    executionHandler: text("execution_handler").notNull(),
    executionMode: text("execution_mode").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull(),
  },
  (t) => ({
    toolIdx: index("tool_versions_tool_idx").on(t.toolId),
    toolLatestIdx: uniqueIndex("tool_versions_tool_latest_idx")
      .on(t.toolId)
      .where(sql`is_latest = true`),
    toolVersionIdx: uniqueIndex("tool_versions_tool_version_idx").on(t.toolId, t.versionNumber),
  }),
);

export const toolAssignments = agentSchema.table(
  "tool_assignments",
  {
    ...idMixin("tas"),
    agentVersionId: uuid("agent_version_id").notNull(),
    toolVersionId: uuid("tool_version_id").notNull(),
    policyConfig: jsonb("policy_config").notNull(),
  },
  (t) => ({
    agentVersionIdx: index("tool_assignments_agent_version_idx").on(t.agentVersionId),
    toolVersionIdx: index("tool_assignments_tool_version_idx").on(t.toolVersionId),
    pairIdx: uniqueIndex("tool_assignments_pair_idx").on(t.agentVersionId, t.toolVersionId),
  }),
);

export const mcpServers = agentSchema.table(
  "mcp_servers",
  {
    ...idMixin("mcs"),
    ...auditMixin(),
    ...tenantScopeMixin(),
    name: text("name").notNull(),
    transportType: text("transport_type").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    authStrategy: text("auth_strategy").notNull(),
    healthStatus: text("health_status").notNull(),
    lastHealthcheckAt: timestamp("last_healthcheck_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    tenantIdx: index("mcp_servers_tenant_idx").on(t.tenantId, t.workspaceId),
  }),
);
