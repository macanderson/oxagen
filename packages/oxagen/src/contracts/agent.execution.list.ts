import { z } from "zod";
import { registerCapability } from "../registry";

// List recent top-level agent executions (runs) for the workspace, newest first,
// with keyset pagination on created_at. Only root runs are returned
// (parent_execution_id IS NULL) so the list shows one row per run; the span
// tree (agent.trace.get) expands a run into its steps, tool calls, and child
// executions. Backs the in-app Activity list and is callable from agent/MCP/API.

export const agentExecutionList = registerCapability({
  name: "list_executions",
  domain: "agent",
  description:
    "List recent top-level agent runs (executions) for the workspace, newest first, with keyset pagination — each row's status, origin, duration, token/cost figures.",
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Max runs to return (1–100)"),
    before: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Keyset cursor: return runs created strictly before this ISO timestamp",
      ),
    status: z
      .enum(["planning", "running", "completed", "failed", "cancelled"])
      .optional()
      .describe("Filter to one execution status"),
  }),
  output: z.object({
    executions: z.array(
      z.object({
        executionId: z.string(),
        status: z.enum([
          "planning",
          "running",
          "completed",
          "failed",
          "cancelled",
        ]),
        originType: z.string(),
        originId: z.string(),
        agentId: z.string().nullable(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        latencyMs: z.number().int().nullable(),
        inputTokens: z.number().int().nullable(),
        outputTokens: z.number().int().nullable(),
        estimatedCostUsd: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        "Pass as `before` to fetch the next page; null when no more rows",
      ),
  }),
});

export type AgentExecutionListInput = z.output<typeof agentExecutionList.input>;
export type AgentExecutionListOutput = z.output<
  typeof agentExecutionList.output
>;
