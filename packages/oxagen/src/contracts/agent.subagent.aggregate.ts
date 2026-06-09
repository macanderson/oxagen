import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSubagentAggregate = registerCapability({
  name: "agent.subagent.aggregate",
  domain: "agent",
  description:
    "Wait for all child runs in a subagent fanout to complete and return merged results, conflict list, and execution timeline",
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
      .describe("Max milliseconds to wait for all children to finish (default 5 min, max 30 min)"),
  }),
  output: z.object({
    fanoutId: z.string(),
    status: z.enum(["completed", "partial", "failed", "timed_out"]),
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
    firstError: z.string().nullable().describe("Error reason from the first failed child run, or null"),
  }),
});

export type AgentSubagentAggregateInput = z.output<typeof agentSubagentAggregate.input>;
export type AgentSubagentAggregateOutput = z.output<typeof agentSubagentAggregate.output>;
