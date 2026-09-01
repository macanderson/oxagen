import { z } from "zod";
import { registerCapability } from "../registry";

// Read side of the subagent fan-out feature. Lists fan-out aggregates for the
// active workspace so a user can watch what the in-app agent dispatched —
// like Claude Code's agent monitor. Pairs with agent.subagent.fanout.get for
// the per-fanout child-run detail.
export const agentSubagentFanoutList = registerCapability({
  name: "list_subagent_fanouts",
  domain: "agent",
  description:
    "List subagent fan-outs for the active workspace with status and child-run counts. Optionally filter by the parent message that triggered the fan-out.",
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
    parentMessageId: z
      .string()
      .optional()
      .describe("Restrict results to fan-outs triggered by this message"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of fan-outs to return, newest first"),
  }),
  output: z.object({
    fanouts: z.array(
      z.object({
        fanoutId: z
          .string()
          .describe(
            "Public ID of the fan-out — pass to agent.subagent.fanout.get",
          ),
        parentMessageId: z.string(),
        status: z.enum([
          "pending",
          "running",
          "completed",
          "partial",
          "timed_out",
        ]),
        totalChildren: z.number().int(),
        completedChildren: z.number().int(),
        createdAt: z.string().describe("ISO timestamp the fan-out was created"),
        updatedAt: z
          .string()
          .describe("ISO timestamp of the last status change"),
      }),
    ),
  }),
});

export type AgentSubagentFanoutListInput = z.output<
  typeof agentSubagentFanoutList.input
>;
export type AgentSubagentFanoutListOutput = z.output<
  typeof agentSubagentFanoutList.output
>;
