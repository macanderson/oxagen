import { z } from "zod";
import { registerCapability } from "../registry";

// Introspection: who holds what (docs/specs/agent-file-locking/plan.md §7).
// Lists every currently-LIVE HOLDS_LOCK edge in the tenant, optionally
// filtered to one file — useful for debugging a stuck fleet (a lock that
// outlives its owning turn is visible here until TTL/sweep reap it).
export const agentFileLockList = registerCapability({
  name: "agent.file.lock.list",
  domain: "agent",
  description: "List every currently-live file lock in the workspace, optionally filtered to one file.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    path: z.string().optional().describe("File path (or naturalKey) to filter to. Omit to list every live lock."),
    owner: z.string().optional().describe("GitHub owner — combined with repo + path to derive the naturalKey filter."),
    repo: z.string().optional().describe("GitHub repo — see owner."),
  }),
  output: z.object({
    locks: z.array(
      z.object({
        lockId: z.string(),
        naturalKey: z.string(),
        agentId: z.string().describe("Identity currently holding the lock."),
        acquiredAt: z.number().int(),
        expiresAt: z.number().int(),
        workspaceId: z.string(),
        action: z.string(),
        executionId: z.string(),
      }),
    ),
  }),
});

export type AgentFileLockListInput = z.output<typeof agentFileLockList.input>;
export type AgentFileLockListOutput = z.output<typeof agentFileLockList.output>;
