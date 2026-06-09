import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid, numeric, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import {
  auditMixin,
  citext,
  idMixin,
  softDeleteMixin,
  orgScopeMixin,
  versionMixin,
} from "./_mixins";

// Skills (spec §6, agent-runtime epic). Logical identity + immutable
// versions, mirroring the agents/tools/playbooks versioning pattern.
// NOTE: agent.agents and agent.agent_versions tables were dropped in migration 0024
// (orphaned schema with zero CRUD usage despite Drizzle definitions).
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
    // Per-workspace enable toggle (distinct from soft-delete). Disabled skills
    // are excluded from agent tool materialization but remain authorable.
    enabled: boolean("enabled").notNull().default(true),
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
    // Workspace enable/disable toggle for a marketplace-installed server. Survives
    // disable so config + cached discoveredTools aren't lost. The runtime injects
    // tools only when enabled = true AND healthStatus = 'healthy'.
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => ({
    orgIdx: index("mcp_servers_org_idx").on(t.orgId, t.workspaceId),
    enabledIdx: index("mcp_servers_enabled_idx").on(t.workspaceId, t.enabled),
    // Partial unique: one install row per (workspace, org_listing); legacy
    // custom rows with NULL org_listing_id are unaffected.
    wsListingUniq: uniqueIndex("mcp_servers_ws_listing_uniq")
      .on(t.workspaceId, t.orgListingId)
      .where(sql`org_listing_id IS NOT NULL`),
  }),
);

// Agent execution tracking: lineage, steps, tool calls (migration 0019)
export const agentExecutions = agentSchema.table(
  "agent_executions",
  {
    ...idMixin("aex"),
    ...auditMixin(),
    ...orgScopeMixin(),
    agentId: uuid("agent_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    originType: citext("origin_type").notNull(),
    originId: uuid("origin_id").notNull(),
    status: citext("status").notNull().default("planning"),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 }),
    syncedToGraphAt: timestamp("synced_to_graph_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    orgStatusIdx: index("agent_executions_org_status_idx").on(t.orgId, t.workspaceId, t.status),
    originIdx: index("agent_executions_origin_idx").on(t.originType, t.originId),
    agentIdx: index("agent_executions_agent_idx").on(t.agentId),
    createdAtIdx: index("agent_executions_created_at_idx").on(t.createdAt),
  }),
);

export const agentExecutionSteps = agentSchema.table(
  "agent_execution_steps",
  {
    ...idMixin("aes"),
    ...auditMixin(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => agentExecutions.id),
    ...orgScopeMixin(),
    stepNumber: integer("step_number").notNull(),
    stepType: citext("step_type").notNull(),
    status: citext("status").notNull(),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    failureReason: text("failure_reason"),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (t) => ({
    executionIdx: index("agent_execution_steps_execution_idx").on(t.executionId),
    orgIdx: index("agent_execution_steps_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const agentToolCalls = agentSchema.table(
  "agent_tool_calls",
  {
    ...idMixin("atc"),
    ...auditMixin(),
    executionStepId: uuid("execution_step_id")
      .notNull()
      .references(() => agentExecutionSteps.id),
    ...orgScopeMixin(),
    toolName: text("tool_name").notNull(),
    toolType: citext("tool_type").notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    responsePayload: jsonb("response_payload"),
    status: citext("status").notNull(),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    stepIdx: index("agent_tool_calls_step_idx").on(t.executionStepId),
    toolIdx: index("agent_tool_calls_tool_idx").on(t.toolName),
    orgIdx: index("agent_tool_calls_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Agent plans: structured execution plans with approval gates.
// Status flow: draft → awaiting_approval → approved | denied | amended → executing → completed.
// Plans are immutable after approval.
export const agentPlans = agentSchema.table(
  "agent_plans",
  {
    ...idMixin("pln"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // status constrained via CHECK in migration
    status: citext("status").notNull().default("draft"),
    goals: jsonb("goals").notNull().default(sql`'[]'::jsonb`),
    constraints: jsonb("constraints").notNull().default(sql`'[]'::jsonb`),
    tasks: jsonb("tasks").notNull().default(sql`'[]'::jsonb`),
    approvalRequired: boolean("approval_required").notNull().default(true),
    messageId: uuid("message_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    approvedByUserId: uuid("approved_by_user_id"),
    taskCount: integer("task_count").notNull().default(0),
  },
  (t) => ({
    orgStatusIdx: index("agent_plans_org_status_idx").on(t.orgId, t.workspaceId, t.status),
    orgIdx: index("agent_plans_org_idx").on(t.orgId, t.workspaceId),
    messageIdx: index("agent_plans_message_idx").on(t.messageId),
  }),
);
