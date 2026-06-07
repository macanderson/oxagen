import { bigint, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import { auditMixin, citext, idMixin, orgScopeMixin } from "./_mixins";

/**
 * Canonical agent execution record (transactional, ACID).
 * Captures every agent invocation across all dispatch origins:
 * chat, event_trigger, scheduled_job, mcp_request, workflow_run.
 *
 * This is the metering boundary — all cost reconciliation flows through
 * estimated_cost_usd. Async workers (Neo4j, ClickHouse) mirror this data
 * for graph topology and analytics; Postgres is the source of truth.
 */
export const agentExecutions = agentSchema.table(
  "agent_executions",
  {
    ...idMixin("aex"),
    ...auditMixin(),
    ...orgScopeMixin(),

    // Agent identity
    agentId: uuid("agent_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),

    // Polymorphic origin (exactly one non-null, enforced by CHECK in migration)
    originType: citext("origin_type").notNull(),
    originId: uuid("origin_id").notNull(),

    // Execution state
    status: citext("status").notNull().default("planning"),
    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    failureReason: text("failure_reason"),

    // Telemetry (canonical for metering)
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    latencyMs: bigint("latency_ms", { mode: "bigint" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCostUsd: text("estimated_cost_usd"), // numeric, serialized as text for JSON compat

    // Sync flag for Neo4j mirror (async, eventual consistency)
    syncedToGraphAt: timestamp("synced_to_graph_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // Query by origin to find all executions from a source
    originIdx: index("agent_executions_origin_idx").on(t.originType, t.originId),
    // Query by status for filtering
    statusIdx: index("agent_executions_status_idx").on(t.status),
    // Query by agent to find all invocations of an agent
    agentIdx: index("agent_executions_agent_idx").on(t.agentId),
    // Query by creation time for pagination, trends
    createdAtIdx: index("agent_executions_created_at_idx").on(t.createdAt),
  }),
);

/**
 * Step-level detail within an execution.
 * Captures each step of an agent's execution plan (tool calls, decisions, retries).
 * Enables drilling down from execution → steps → tool calls.
 */
export const agentExecutionSteps = agentSchema.table(
  "agent_execution_steps",
  {
    ...idMixin("aes"),
    ...auditMixin(),
    ...orgScopeMixin(),

    executionId: uuid("execution_id").notNull(),
    stepNumber: integer("step_number").notNull(),
    stepType: citext("step_type").notNull(),
    status: citext("status").notNull(),

    inputPayload: jsonb("input_payload").notNull(),
    outputPayload: jsonb("output_payload"),
    failureReason: text("failure_reason"),

    latencyMs: bigint("latency_ms", { mode: "bigint" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (t) => ({
    // Query steps within an execution
    executionIdx: index("agent_execution_steps_execution_idx").on(t.executionId),
    // Ensure step numbers are unique per execution
    uniqueStepIdx: sql`UNIQUE (${t.executionId}, ${t.stepNumber})`,
  }),
);

/**
 * Tool invocation detail within a step.
 * Captures each tool call made by an agent (MCP tools, capabilities, builtins).
 * Enables tracing: execution → step → tool call → request/response.
 */
export const agentToolCalls = agentSchema.table(
  "agent_tool_calls",
  {
    ...idMixin("atc"),
    ...orgScopeMixin(),

    executionStepId: uuid("execution_step_id").notNull(),

    toolName: text("tool_name").notNull(),
    toolType: citext("tool_type").notNull(), // mcp | capability | builtin

    requestPayload: jsonb("request_payload").notNull(),
    responsePayload: jsonb("response_payload"),
    status: text("status").notNull(),

    latencyMs: bigint("latency_ms", { mode: "bigint" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Query tool calls within a step
    stepIdx: index("agent_tool_calls_step_idx").on(t.executionStepId),
    // Query by tool name for analytics
    toolIdx: index("agent_tool_calls_tool_idx").on(t.toolName),
  }),
);
