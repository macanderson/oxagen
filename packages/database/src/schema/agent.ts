import { boolean, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid, numeric, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import {
  auditMixin,
  citext,
  idMixin,
  softDeleteMixin,
  orgScopeMixin,
  versionMixin,
  uuidv7Default,
} from "./_mixins";

// Agent identity + versioning (spec §6, agent-runtime epic).
export const agents = agentSchema.table(
  "agents",
  {
    ...idMixin("agt"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    slug: citext("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    agentType: text("agent_type").notNull(),
    activeVersionId: uuid("active_version_id"),
    // status: text + check per spec §6
    status: text("status").notNull().default("draft"),
  },
  (t) => ({
    workspaceSlugUniq: uniqueIndex("agents_workspace_slug_uniq")
      .on(t.workspaceId, t.slug)
      .where(sql`deleted_at IS NULL`),
    orgIdx: index("agents_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check("agents_status_check", sql`${t.status} IN ('draft', 'active', 'archived')`),
    slugCheck: check("agents_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  }),
);

// Immutable version snapshots. INSERT-only once published; no updatedAt by design.
export const agentVersions = agentSchema.table(
  "agent_versions",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    version: integer("version").notNull(),
    isPublished: boolean("is_published").notNull().default(false),
    // checksum: SHA-256 over canonical config — immutability contract.
    checksum: text("checksum"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // No updatedAt by design — INSERT-only once published.
  },
  (t) => ({
    agentVersionUniq: uniqueIndex("agent_versions_agent_version_uniq").on(t.agentId, t.version),
    agentIdx: index("agent_versions_agent_idx").on(t.agentId),
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
    status: text("status").notNull(),
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
    statusCheck: check("background_tasks_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`),
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
    riskLevel: text("risk_level").notNull(),
    // resolution null until resolved.
    resolution: text("resolution"),
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
    resolutionCheck: check("approval_requests_resolution_check", sql`${t.resolution} IN ('approved', 'denied', 'expired') OR ${t.resolution} IS NULL`),
    riskLevelCheck: check("approval_requests_risk_level_check", sql`${t.riskLevel} IN ('low', 'medium', 'high', 'critical')`),
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
    status: text("status").notNull(),
    totalChildren: integer("total_children").notNull(),
    completedChildren: integer("completed_children").notNull().default(0),
  },
  (t) => ({
    orgIdx: index("subagent_fanouts_org_idx").on(t.orgId, t.workspaceId),
    parentMessageIdx: index("subagent_fanouts_parent_message_idx").on(t.parentMessageId),
    statusCheck: check("subagent_fanouts_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'partial', 'timed_out')`),
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
    status: text("status").notNull(),
    errorReason: text("error_reason"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    fanoutIdx: index("subagent_runs_fanout_idx").on(t.fanoutId),
    statusIdx: index("subagent_runs_status_idx").on(t.status),
    orgIdx: index("subagent_runs_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check("subagent_runs_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed')`),
  }),
);

// Agent execution tracking: lineage, steps, tool calls (migration 0019)
export const agentExecutions = agentSchema.table(
  "agent_executions",
  {
    ...idMixin("aex"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // Nullable: dynamic supervisor runs don't have a pre-registered agent definition.
    agentId: uuid("agent_id").references(() => agents.id),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id),
    originType: text("origin_type").notNull(),
    originId: uuid("origin_id").notNull(),
    status: text("status").notNull().default("planning"),
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
    statusCheck: check("agent_executions_status_check", sql`${t.status} IN ('planning', 'running', 'completed', 'failed', 'cancelled')`),
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
    stepType: text("step_type").notNull(),
    status: text("status").notNull(),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    failureReason: text("failure_reason"),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    executionIdx: index("agent_execution_steps_execution_idx").on(t.executionId),
    orgIdx: index("agent_execution_steps_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check("agent_execution_steps_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`),
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
    toolType: text("tool_type").notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    responsePayload: jsonb("response_payload"),
    status: text("status").notNull(),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (t) => ({
    stepIdx: index("agent_tool_calls_step_idx").on(t.executionStepId),
    toolIdx: index("agent_tool_calls_tool_idx").on(t.toolName),
    orgIdx: index("agent_tool_calls_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check("agent_tool_calls_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed')`),
  }),
);

// Agent plans: structured execution plans with approval gates.
// Status flow: draft → awaiting_approval → approved | denied | amended → executing → completed.
// Plans are immutable after approval.
export const agentPlans = agentSchema.table(
  "agent_plans",
  {
    ...idMixin("apl"),
    ...auditMixin(),
    ...orgScopeMixin(),
    status: text("status").notNull().default("draft"),
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
    statusCheck: check("agent_plans_status_check", sql`${t.status} IN ('draft', 'awaiting_approval', 'approved', 'denied', 'amended', 'executing', 'completed')`),
  }),
);
