import { index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSchema } from "./_schemas";
import { auditMixin, citext, idMixin, orgScopeMixin } from "./_mixins";

export const workflowRuns = agentSchema.table(
  "workflow_runs",
  {
    ...idMixin("wfr"),
    ...auditMixin(),
    ...orgScopeMixin(),
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
    orgStatusIdx: index("workflow_runs_org_status_idx").on(t.orgId, t.workspaceId, t.status),
    orgIdx: index("workflow_runs_org_idx").on(t.orgId, t.workspaceId),
  }),
);

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
