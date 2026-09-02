import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Canonical agent-execution origin types. MUST stay in sync with the
 * `agent_executions_origin_type_check` CHECK constraint in
 * packages/database/src/schema/agent.ts (and the baseline/0007 migrations).
 * Tokens use underscores ("workflow_run", not "workflow.run") — a mismatched
 * value is rejected by Postgres at INSERT.
 */
export const AGENT_EXECUTION_ORIGIN_TYPES = [
  "chat",
  "event_trigger",
  "scheduled_job",
  "mcp_request",
  "workflow_run",
  // Terminal subagent fanout children projected as :Execution graph nodes
  // (docs/specs/graph-mediated-fanout-phase2 §2). Migration
  // 20260703150000_phase2_claim_lease widened the CHECK in lockstep.
  "fanout",
] as const;

const executionStepSchema = z.object({
  stepNumber: z.number().int().nonnegative(),
  stepType: z.string(),
  status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
  inputPayload: z.unknown(),
  outputPayload: z.unknown().optional(),
  failureReason: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  toolCalls: z
    .array(
      z.object({
        toolName: z.string(),
        toolType: z.string(),
        requestPayload: z.unknown(),
        responsePayload: z.unknown().optional(),
        status: z.enum(["pending", "running", "completed", "failed"]),
        latencyMs: z.number().int().nonnegative().optional(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});

export const agentExecutionRecord = registerCapability({
  name: "record_execution",
  domain: "agent",
  description:
    "Persist a complete agent execution record including steps and tool calls for observability, billing, and audit",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z.string().uuid(),
    agentVersionId: z.string().uuid(),
    originType: z.enum(AGENT_EXECUTION_ORIGIN_TYPES),
    originId: z.string().uuid(),
    status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
    inputPayload: z.unknown(),
    outputPayload: z.unknown().optional(),
    failureReason: z.string().optional(),
    startedAt: z.coerce.date().optional(),
    completedAt: z.coerce.date().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    steps: z.array(executionStepSchema).optional(),
  }),
  output: z.object({
    executionId: z.string().uuid(),
    status: z.string(),
    createdAt: z.coerce.date(),
  }),
});

export type AgentExecutionRecordInput = z.output<
  typeof agentExecutionRecord.input
>;
export type AgentExecutionRecordOutput = z.output<
  typeof agentExecutionRecord.output
>;
