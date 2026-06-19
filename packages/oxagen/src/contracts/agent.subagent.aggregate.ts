import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSubagentAggregate = registerCapability({
  name: "agent.subagent.aggregate",
  domain: "agent",
  description:
    "Return the current merged results, conflict list, and execution timeline for a subagent fanout. Non-blocking: reports the live status (running until children finish) — durable waiting is handled by the agent.aggregate-fanout Inngest function.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "background" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    fanoutId: z.string().describe("Public ID of the subagent fanout to aggregate"),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 60 * 1000)
      .default(5 * 60 * 1000)
      .describe(
        "Snapshot window in ms: a still-running fanout older than this is reported as 'timed_out' rather than 'running' (default 5 min, max 30 min). Non-blocking — the handler never sleeps.",
      ),
  }),
  output: z.object({
    fanoutId: z.string(),
    status: z
      .enum(["pending", "running", "completed", "partial", "failed", "timed_out"])
      .describe(
        "running/pending = children still executing (aggregatedData null); completed = all succeeded; partial = some succeeded, some failed/incomplete (merged data of the successful subset); failed = none succeeded; timed_out = still unfinished past the snapshot window",
      ),
    totalChildren: z.number().int(),
    completedChildren: z.number().int(),
    aggregatedData: z.record(z.unknown()).nullable().describe("Merged output data from all successful runs"),
    conflicts: z
      .array(
        z.object({
          key: z.string(),
          values: z.array(z.unknown()),
          runIds: z.array(z.string()),
        }),
      )
      .describe("Keys where two or more runs produced different values"),
    timeline: z.array(
      z.object({
        runId: z.string(),
        capabilityName: z.string(),
        status: z.string(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        errorReason: z.string().nullable(),
      }),
    ),
    children: z
      .array(
        z.object({
          runId: z.string(),
          capabilityName: z.string(),
          status: z.string(),
          input: z.unknown(),
          output: z.unknown(),
          errorReason: z.string().nullable(),
        }),
      )
      .describe(
        "Per-child run with its FULL input + output payloads — the raw fan-out " +
          "results. Unlike aggregatedData (which deep-merges and collides on shared " +
          "keys like `results`), this preserves each child's distinct result so " +
          "callers can present per-task output (e.g. each web.search query's hits).",
      ),
    firstError: z.string().nullable().describe("Error reason from the first failed child run, or null"),
  }),
});

export type AgentSubagentAggregateInput = z.output<typeof agentSubagentAggregate.input>;
export type AgentSubagentAggregateOutput = z.output<typeof agentSubagentAggregate.output>;
