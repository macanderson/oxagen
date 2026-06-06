import { bigint, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { executionSchema } from "./_schemas";
import { executionStatusMixin, idMixin, orgScopeMixin } from "./_mixins";

export const executions = executionSchema.table(
  "executions",
  {
    ...idMixin("exe"),
    ...executionStatusMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    playbookVersionId: uuid("playbook_version_id").notNull(),
    triggerEventId: uuid("trigger_event_id"),
    // Links chat-initiated executions back to the originating message.
    // At most one of trigger_event_id and triggered_by_message_id is
    // non-null (enforced by CHECK in the initial migration).
    triggeredByMessageId: uuid("triggered_by_message_id"),
    startedByUserId: uuid("started_by_user_id"),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    failureReason: text("failure_reason"),
  },
  (t) => ({
    orgIdx: index("executions_org_idx").on(t.orgId, t.workspaceId),
    statusIdx: index("executions_status_idx").on(t.status),
    startedAtIdx: index("executions_started_at_idx").on(t.startedAt),
    playbookVersionIdx: index("executions_playbook_version_idx").on(t.playbookVersionId),
    triggeredByMessageIdx: index("executions_triggered_by_message_idx").on(t.triggeredByMessageId),
  }),
);

export const executionSteps = executionSchema.table(
  "execution_steps",
  {
    ...idMixin("exs"),
    ...executionStatusMixin(),
    ...orgScopeMixin(),
    executionId: uuid("execution_id").notNull(),
    playbookStepId: uuid("playbook_step_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    tokenUsage: jsonb("token_usage"),
    latencyMs: bigint("latency_ms", { mode: "bigint" }),
    failureReason: text("failure_reason"),
  },
  (t) => ({
    executionIdx: index("execution_steps_execution_idx").on(t.executionId),
    statusIdx: index("execution_steps_status_idx").on(t.status),
    startedAtIdx: index("execution_steps_started_at_idx").on(t.startedAt),
    stepIdx: index("execution_steps_step_idx").on(t.playbookStepId),
    orgIdx: index("execution_steps_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const toolCalls = executionSchema.table(
  "tool_calls",
  {
    ...idMixin("tcl"),
    ...orgScopeMixin(),
    executionStepId: uuid("execution_step_id").notNull(),
    toolVersionId: uuid("tool_version_id").notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    responsePayload: jsonb("response_payload"),
    latencyMs: bigint("latency_ms", { mode: "bigint" }),
    tokenUsage: jsonb("token_usage"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    stepIdx: index("tool_calls_step_idx").on(t.executionStepId),
    toolVersionIdx: index("tool_calls_tool_version_idx").on(t.toolVersionId),
    statusIdx: index("tool_calls_status_idx").on(t.status),
    orgIdx: index("tool_calls_org_idx").on(t.orgId, t.workspaceId),
  }),
);

