import { z } from "zod";
import { registerCapability } from "../registry";

// `agent.sandbox.stop` terminates a durable sandbox session and marks the
// registry row stopped. Stop sessions when the work is done (PR opened) so the
// container stops billing — idle reaping is the safety net, but explicit stop
// is the clean path.

export const agentSandboxStop = registerCapability({
  name: "stop_sandbox",
  domain: "agent",
  description:
    "Terminate a durable sandbox session and release its resources. Call when the work is finished.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "execution" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    sessionId: z
      .string()
      .min(1)
      .describe("Durable-session id (sbx_…) returned by agent.sandbox.start."),
  }),
  output: z.object({
    stopped: z.boolean(),
  }),
});

export type AgentSandboxStopInput = z.output<typeof agentSandboxStop.input>;
export type AgentSandboxStopOutput = z.output<typeof agentSandboxStop.output>;
