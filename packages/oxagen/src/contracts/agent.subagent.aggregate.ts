import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentSubagentAggregate = registerCapability({
  name: "agent.subagent.aggregate",
  domain: "agent",
  description: "Collect the completed results of a previously-dispatched fanout for parent-message synthesis",
  mode: "sync",
  surfaces: ["agent"],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "dispatch" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    fanoutId: z.string(),
    waitForCompletion: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
  }),
  output: z.object({
    fanoutId: z.string(),
    status: z.enum(["pending", "completed", "partial", "timed_out"]),
    results: z.array(
      z.object({
        childMessageId: z.string(),
        capability: z.string(),
        status: z.enum(["completed", "failed", "pending"]),
        output: z.unknown().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
});

export type AgentSubagentAggregateInput = z.output<typeof agentSubagentAggregate.input>;
export type AgentSubagentAggregateOutput = z.output<typeof agentSubagentAggregate.output>;
