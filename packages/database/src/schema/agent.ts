import { boolean, index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import {
  auditMixin,
  citext,
  idMixin,
  jsonContractMixin,
  softDeleteMixin,
  orgScopeMixin,
  versionMixin,
} from "./_mixins";

export const agents = agentSchema.table(
  "agents",
  {
    ...idMixin("agt"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
    defaultModel: text("default_model").notNull(),
    isSystemAgent: boolean("is_system_agent").notNull().default(false),
  },
  (t) => ({
    orgSlugIdx: uniqueIndex("agents_org_slug_idx").on(t.orgId, t.slug),
    orgIdx: index("agents_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const agentVersions = agentSchema.table(
  "agent_versions",
  {
    ...idMixin("agv"),
    ...auditMixin(),
    ...orgScopeMixin(),
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
    orgIdx: index("agent_versions_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const tools = agentSchema.table(
  "tools",
  {
    ...idMixin("tol"),
    ...auditMixin(),
    ...orgScopeMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    toolType: text("tool_type").notNull(),
    description: text("description").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    // Agent-runtime extensions (spec §6). risk_level is constrained via
    // CHECK in the migration; Drizzle treats it as free-text citext.
    requiresApproval: boolean("requires_approval").notNull().default(false),
    riskLevel: citext("risk_level").notNull().default("low"),
    category: text("category"),
  },
  (t) => ({
    orgSlugIdx: uniqueIndex("tools_org_slug_idx").on(t.orgId, t.slug),
    orgIdx: index("tools_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Skills (spec §6, agent-runtime epic). Logical identity + immutable
// versions, mirroring the agents/tools/playbooks versioning pattern.
export const skills = agentSchema.table(
  "skills",
  {
    ...idMixin("skl"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
    // builtin = shipped in packages/skills; tenant = workspace-authored.
    source: citext("source").notNull(),
  },
  (t) => ({
    workspaceSlugIdx: uniqueIndex("skills_workspace_slug_idx").on(t.workspaceId, t.slug),
    orgIdx: index("skills_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const skillVersions = agentSchema.table(
  "skill_versions",
  {
    ...idMixin("slv"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...versionMixin(),
    skillId: uuid("skill_id").notNull(),
    body: text("body").notNull(),
    // References from the .skill.md frontmatter (graph nodes, files, etc).
    referencesPayload: jsonb("references_payload").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => ({
    skillIdx: index("skill_versions_skill_idx").on(t.skillId),
    skillLatestIdx: uniqueIndex("skill_versions_skill_latest_idx")
      .on(t.skillId)
      .where(sql`is_latest = true`),
    skillVersionIdx: uniqueIndex("skill_versions_skill_version_idx").on(t.skillId, t.versionNumber),
    orgIdx: index("skill_versions_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Background tasks tracking agent.task.background.* Inngest runs.
export const backgroundTasks = agentSchema.table(
  "background_tasks",
  {
    ...idMixin("bgt"),
    ...auditMixin(),
    ...orgScopeMixin(),
    kind: text("kind").notNull(),
    label: text("label"),
    inngestRunId: text("inngest_run_id").notNull().unique(),
    // status constrained via CHECK in migration to pending|running|completed|failed|cancelled.
    status: citext("status").notNull(),
    inputPayload: jsonb("input_payload").notNull(),
    resultPayload: jsonb("result_payload"),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => ({
    orgStatusIdx: index("background_tasks_org_status_idx").on(
      t.orgId,
      t.workspaceId,
      t.status,
    ),
    orgIdx: index("background_tasks_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Approval requests: cross-domain references (execution_step_id, message_id,
// tool_call_id) are app-enforced; FKs stay within the agent schema per
// CLAUDE.md storage rules.
export const approvalRequests = agentSchema.table(
  "approval_requests",
  {
    ...idMixin("apr"),
    ...auditMixin(),
    ...orgScopeMixin(),
    executionStepId: uuid("execution_step_id"),
    toolCallId: uuid("tool_call_id"),
    messageId: uuid("message_id").notNull(),
    capabilityName: text("capability_name").notNull(),
    inputPreview: jsonb("input_preview").notNull(),
    riskLevel: citext("risk_level").notNull(),
    // resolution null until resolved; CHECK approved|denied|expired in migration.
    resolution: citext("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedByUserId: uuid("resolved_by_user_id"),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    orgResolutionIdx: index("approval_requests_org_resolution_idx").on(
      t.orgId,
      t.workspaceId,
      t.resolution,
    ),
    orgIdx: index("approval_requests_org_idx").on(t.orgId, t.workspaceId),
    messageIdx: index("approval_requests_message_idx").on(t.messageId),
  }),
);

// Subagent fanout aggregate; child runs join via subagent_runs.fanout_id.
export const subagentFanouts = agentSchema.table(
  "subagent_fanouts",
  {
    ...idMixin("fan"),
    ...auditMixin(),
    ...orgScopeMixin(),
    parentMessageId: uuid("parent_message_id").notNull(),
    inngestEventId: text("inngest_event_id"),
    // CHECK pending|running|completed|partial|timed_out in migration.
    status: citext("status").notNull(),
    totalChildren: integer("total_children").notNull(),
    completedChildren: integer("completed_children").notNull().default(0),
  },
  (t) => ({
    orgIdx: index("subagent_fanouts_org_idx").on(t.orgId, t.workspaceId),
    parentMessageIdx: index("subagent_fanouts_parent_message_idx").on(t.parentMessageId),
  }),
);

export const subagentRuns = agentSchema.table(
  "subagent_runs",
  {
    ...idMixin("sar"),
    ...auditMixin(),
    ...orgScopeMixin(),
    fanoutId: uuid("fanout_id").notNull(),
    childMessageId: uuid("child_message_id").notNull(),
    capabilityName: text("capability_name").notNull(),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    // CHECK pending|running|completed|failed in migration.
    status: citext("status").notNull(),
    errorReason: text("error_reason"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    fanoutIdx: index("subagent_runs_fanout_idx").on(t.fanoutId),
    statusIdx: index("subagent_runs_status_idx").on(t.status),
    orgIdx: index("subagent_runs_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Plan steps tied to executions. execution_step_id is a cross-domain
// reference (FK omitted per CLAUDE.md storage rules) but indexed.
export const planSteps = agentSchema.table(
  "plan_steps",
  {
    ...idMixin("pls"),
    ...auditMixin(),
    ...orgScopeMixin(),
    executionStepId: uuid("execution_step_id").notNull(),
    planStepKey: text("plan_step_key").notNull(),
    summary: text("summary").notNull(),
    intent: text("intent").notNull(),
    capabilityName: text("capability_name"),
    inputPreview: jsonb("input_preview"),
    dependsOn: jsonb("depends_on").notNull().default(sql`'[]'::jsonb`),
    // CHECK pending|approved|denied|completed|failed in migration.
    status: citext("status").notNull(),
  },
  (t) => ({
    orgIdx: index("plan_steps_org_idx").on(t.orgId, t.workspaceId),
    executionStepIdx: index("plan_steps_execution_step_idx").on(t.executionStepId),
    orgStatusIdx: index("plan_steps_org_status_idx").on(
      t.orgId,
      t.workspaceId,
      t.status,
    ),
  }),
);

export const mcpServers = agentSchema.table(
  "mcp_servers",
  {
    ...idMixin("mcs"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // Links a workspace install back to its org allow-list row
    // (plugin.org_listings). Nullable only because the column was added to an
    // existing table with no rows to backfill; the plugin install handler
    // (Plan 3) requires it on every insert. Treat as required when querying.
    orgListingId: uuid("org_listing_id"),
    name: text("name").notNull(),
    transportType: text("transport_type").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    authStrategy: text("auth_strategy").notNull(),
    authConfig: jsonb("auth_config").notNull().default(sql`'{}'::jsonb`),
    healthStatus: text("health_status").notNull(),
    lastHealthcheckAt: timestamp("last_healthcheck_at", { withTimezone: true, mode: "date" }),
    discoveredTools: jsonb("discovered_tools").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => ({
    orgIdx: index("mcp_servers_org_idx").on(t.orgId, t.workspaceId),
  }),
);
