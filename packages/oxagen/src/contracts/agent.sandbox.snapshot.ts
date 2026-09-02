import { z } from "zod";
import { registerCapability } from "../registry";

// `agent.sandbox.snapshot` captures a filesystem snapshot of a durable sandbox.
// The snapshot lets the session survive an idle reap or the 24h lifetime
// ceiling: the next exec restores from it transparently. Take a snapshot at
// meaningful milestones (repo cloned, deps installed, feature built).
// Note: cannot snapshot while a command is mid-flight in the session.

export const agentSandboxSnapshot = registerCapability({
  name: "snapshot_sandbox",
  domain: "agent",
  description:
    "Capture a filesystem snapshot of a durable sandbox session so it can be restored after an idle reap or the 24h lifetime ceiling.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "execution",
  },
  sensitivity: "medium",
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
    snapshotId: z
      .string()
      .describe(
        "Filesystem snapshot id, recorded on the session for transparent restore.",
      ),
  }),
});

export type AgentSandboxSnapshotInput = z.output<
  typeof agentSandboxSnapshot.input
>;
export type AgentSandboxSnapshotOutput = z.output<
  typeof agentSandboxSnapshot.output
>;
