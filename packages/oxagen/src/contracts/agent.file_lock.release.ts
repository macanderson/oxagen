import { z } from "zod";
import { registerCapability } from "../registry";

// Manual/admin release (docs/specs/agent-file-locking/plan.md §5, §7).
// Gated to Owner/Admin ONLY (unlike acquire, which workspace Members can
// also call) — this is deliberately the debug/operator path for clearing a
// lock a crashed agent left behind before its TTL lapses, so it force-releases
// by lockId alone (@oxagen/ontology's forceReleaseFileLock), without needing
// the original holder's internal agentId.
export const agentFileLockRelease = registerCapability({
  name: "release_file_lock",
  aliases: ["agent.file_lock.release", "agent.file.lock.release"],
  domain: "agent",
  description:
    "Force-release a file lock by its lockId — for clearing a lock a crashed/stuck agent left behind. Does not require the original holder's agentId.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "write" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    lockId: z.string().describe("The lockId returned by agent.file.lock.acquire or agent.file.lock.list."),
  }),
  output: z.object({
    released: z.boolean().describe("false when no matching lock existed (idempotent, not an error)."),
  }),
});

export type AgentFileLockReleaseInput = z.output<typeof agentFileLockRelease.input>;
export type AgentFileLockReleaseOutput = z.output<typeof agentFileLockRelease.output>;
