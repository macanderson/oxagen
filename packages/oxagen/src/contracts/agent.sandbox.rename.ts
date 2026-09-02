import { z } from "zod";
import { registerCapability } from "../registry";

// `rename_sandbox` sets the human-friendly display label on a durable sandbox
// session so a person can tell warm sandboxes apart in the list. The label is a
// display-only field stored in the session's metadata JSON blob — it never
// affects reuse (that is keyed by sessionKey) or the driver-side sandbox. This
// is the mutable counterpart to the `label` first supplied at `start_sandbox`
// time; renaming merges the new label into the existing metadata rather than
// overwriting the frozen session spec.
export const agentSandboxRename = registerCapability({
  name: "rename_sandbox",
  domain: "agent",
  description:
    "Rename a durable sandbox session — set its human-friendly display label (shown in the sandbox list). Display-only; does not affect reuse or the running container.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
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
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe(
        "New human-friendly display name for the sandbox (1-80 chars, trimmed).",
      ),
  }),
  output: z.object({
    sessionId: z.string().describe("The renamed session's opaque id (sbx_…)."),
    label: z.string().describe("The label now stored on the session."),
  }),
});

export type AgentSandboxRenameInput = z.output<typeof agentSandboxRename.input>;
export type AgentSandboxRenameOutput = z.output<
  typeof agentSandboxRename.output
>;
