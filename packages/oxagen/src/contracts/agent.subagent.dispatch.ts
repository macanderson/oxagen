import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentSubagentDispatch = registerCapability({
  name: "agent.subagent.dispatch",
  domain: "agent",
  description: "Spawn N subagents in parallel via Inngest fanout; each runs a scoped capability and returns its result for parent aggregation",
  mode: "async",
  surfaces: ["agent"],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "dispatch" },
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    parentMessageId: z.string(),
    fanout: z
      .array(
        z.object({
          capability: z.string(),
          input: z.unknown(),
          label: z.string().optional(),
        }),
      )
      .min(1)
      .max(16),
  }),
  output: z.object({
    fanoutId: z.string(),
    childMessageIds: z.array(z.string()),
  }),
});

export type AgentSubagentDispatchInput = z.output<typeof agentSubagentDispatch.input>;
export type AgentSubagentDispatchOutput = z.output<typeof agentSubagentDispatch.output>;
