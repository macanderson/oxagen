import { z } from "zod";
import { registerCapability } from "../registry";

// Span-tree read for one agent execution: the run itself plus its ordered steps,
// each step's tool calls (with durations, token/cost figures, status), and any
// child executions linked via parent_execution_id (subagent / A2A lineage).
//
// The durable source of truth for the tree is Postgres (agent_executions →
// agent_execution_steps → agent_tool_calls, self-linked via parent_execution_id).
// ClickHouse holds the analytics mirror; Neo4j does NOT carry the execution→
// execution parent edge, so the tree is read from Postgres. Powers the in-app
// run-trace viewer and is callable from the agent/MCP/API/CLI surfaces.

const traceStatus = z.enum([
  "planning",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const toolCallNode = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  toolType: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  latencyMs: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  requestBytes: z
    .number()
    .int()
    .describe("Serialized size of the request payload"),
  responseBytes: z
    .number()
    .int()
    .describe("Serialized size of the response payload, 0 when none"),
  responsePreview: z
    .string()
    .nullable()
    .describe(
      "Truncated JSON preview of the response payload, or null when none",
    ),
});

const stepNode = z.object({
  stepId: z.string(),
  stepNumber: z.number().int(),
  stepType: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  failureReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  toolCalls: z.array(toolCallNode),
});

// One step's derived metrics, computed by @oxagen/engram's extractTurnMetrics
// over a synthetic per-step session (session/replay.ts) -- each execution step
// is treated as one "turn". cacheHitRate is always 0 here: Postgres execution
// rows don't carry engram's context-compile cache telemetry, only tokens/
// latency/tool-call counts, which is what this reuses.
const turnMetric = z.object({
  turnId: z.string().describe("The step's public id (aes_…)"),
  compileMs: z
    .number()
    .int()
    .describe("The step's latencyMs, reused as the turn's duration"),
  tokens: z.number().int().describe("inputTokens + outputTokens for the step"),
  cacheHitRate: z.number(),
  toolCalls: z.number().int(),
  outcome: z.string(),
});

// The recursive execution span node. Each node carries its own steps and any
// child executions (subagent fan-out / A2A). z.lazy defers the self-reference.
export interface TraceExecutionNode {
  executionId: string;
  status: z.infer<typeof traceStatus>;
  originType: string;
  originId: string;
  agentId: string | null;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  createdAt: string;
  updatedAt: string;
  steps: z.infer<typeof stepNode>[];
  children: TraceExecutionNode[];
  /**
   * Per-step metrics + a determinism sanity-check, populated ONLY on the root
   * node (children omit them -- recomputing per descendant isn't worth the
   * cost for a read the UI only ever renders once per trace). See
   * packages/agent/src/handlers/agent.trace.get.ts's deriveTurnMetrics.
   */
  turnMetrics?: z.infer<typeof turnMetric>[];
  replayDeterministic?: boolean;
}

const executionNode: z.ZodType<TraceExecutionNode> = z.lazy(() =>
  z.object({
    executionId: z.string(),
    status: traceStatus,
    originType: z.string(),
    originId: z.string(),
    agentId: z.string().nullable(),
    failureReason: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    latencyMs: z.number().int().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    estimatedCostUsd: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    steps: z.array(stepNode),
    children: z.array(executionNode),
    turnMetrics: z.array(turnMetric).optional(),
    replayDeterministic: z.boolean().optional(),
  }),
);

export const agentTraceGet = registerCapability({
  name: "get_execution_trace",
  domain: "agent",
  description:
    "Get one agent execution as a collapsible span tree — the run, its ordered steps, each step's tool calls with durations/tokens/cost/status, and child executions (subagent/A2A lineage).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    executionId: z
      .string()
      .describe("Public ID (aex_…) or UUID of the execution to fetch"),
  }),
  output: executionNode,
});

export type AgentTraceGetInput = z.output<typeof agentTraceGet.input>;
export type AgentTraceGetOutput = z.output<typeof agentTraceGet.output>;
