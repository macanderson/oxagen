import { z } from "zod";
import { registerCapability } from "../registry";

// Cancel an in-progress subagent fan-out. Transitions the fanout row and
// every non-terminal child run to terminal status, preventing the Inngest
// worker from picking them up. Returns a summary so callers can confirm the
// cancellation without a follow-up poll.
export const agentSubagentCancel = registerCapability({
  name: "agent.subagent.cancel",
  domain: "agent",
  description:
    "Cancel an in-progress subagent fan-out; transitions the fanout and all non-terminal child runs to a terminal status so no further work is performed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "write" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    fanoutId: z.string().describe("Public ID of the fan-out to cancel"),
  }),
  output: z.object({
    fanoutId: z.string(),
    status: z.string().describe("Terminal status the fanout was transitioned to"),
    cancelledChildren: z
      .number()
      .int()
      .describe("Number of child runs that were transitioned to a terminal status"),
  }),
});

export type AgentSubagentCancelInput = z.output<typeof agentSubagentCancel.input>;
export type AgentSubagentCancelOutput = z.output<typeof agentSubagentCancel.output>;
