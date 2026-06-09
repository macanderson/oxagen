import { check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema, workflowSchema } from "./_schemas";
import { auditMixin, citext, idMixin, orgScopeMixin, softDeleteMixin } from "./_mixins";

// Workflow run — execution of a workflow definition. Tracks overall progress.
// Table lives in the `agent` schema in Postgres (agent.workflow_runs).
export const workflowRuns = agentSchema.table(
  "workflow_runs",
  {
    ...idMixin("wfr"),
    ...auditMixin(),
    ...orgScopeMixin(),
    workflowId: uuid("workflow_id"),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    // CHECK planning|running|completed|failed|cancelled in migration.
    status: citext("status").notNull().default("planning"),
    planJson: jsonb("plan_json").notNull().default([]),
    totalTasks: integer("total_tasks").notNull().default(0),
    completedTasks: integer("completed_tasks").notNull().default(0),
    failedTasks: integer("failed_tasks").notNull().default(0),
    maxParallelism: integer("max_parallelism").notNull().default(50),
    // 'json' | 'csv'
    outputFormat: citext("output_format").notNull().default("json"),
    resultUrl: text("result_url"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    workflowIdx: index("workflow_runs_workflow_idx").on(t.workflowId),
    orgStatusIdx: index("workflow_runs_org_status_idx").on(t.orgId, t.workspaceId, t.status),
    orgIdx: index("workflow_runs_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Workflow run task — dynamic task dispatched by the AI planner for a workflow run.
// Table lives in the `agent` schema in Postgres (agent.workflow_run_tasks).
export const workflowRunTasks = agentSchema.table(
  "workflow_run_tasks",
  {
    ...idMixin("wft"),
    ...auditMixin(),
    ...orgScopeMixin(),
    workflowRunId: uuid("workflow_run_id").notNull(),
    taskIndex: integer("task_index").notNull(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    // CHECK pending|running|completed|failed|cancelled in migration.
    status: citext("status").notNull().default("pending"),
    inngestRunId: text("inngest_run_id"),
    outputJson: jsonb("output_json"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    workflowRunIdx: index("workflow_run_tasks_run_idx").on(t.workflowRunId),
    orgStatusIdx: index("workflow_run_tasks_org_status_idx").on(t.orgId, t.workspaceId, t.status),
    orgIdx: index("workflow_run_tasks_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// Automation — a saved trigger→action rule (distinct from workflows, which are
// multi-step task templates). `triggerConfig` holds the trigger descriptors
// surfaced as `triggers: string[]`; `actionConfig` the action payload.
// Backs automation.create / automation.list.
export const automations = workflowSchema.table(
  "automations",
  {
    ...idMixin("aut"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    // CHECK active|paused|archived enforced in migration.
    status: citext("status").notNull().default("active"),
    triggerConfig: jsonb("trigger_config").notNull().default(sql`'[]'::jsonb`),
    actionConfig: jsonb("action_config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    orgIdx: index("automations_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check(
      "automations_status_check",
      sql`${t.status} IN ('active', 'paused', 'archived')`,
    ),
  }),
);

// Automation run — a single execution of an automation. Backs automation.trigger.
export const automationRuns = workflowSchema.table(
  "automation_runs",
  {
    ...idMixin("aur"),
    ...auditMixin(),
    ...orgScopeMixin(),
    automationId: uuid("automation_id").notNull(),
    // CHECK running|completed|failed|cancelled enforced in migration.
    status: citext("status").notNull().default("running"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    automationIdx: index("automation_runs_automation_idx").on(t.automationId),
    orgStatusIdx: index("automation_runs_org_status_idx").on(t.orgId, t.workspaceId, t.status),
    orgIdx: index("automation_runs_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check(
      "automation_runs_status_check",
      sql`${t.status} IN ('running', 'completed', 'failed', 'cancelled')`,
    ),
  }),
);
