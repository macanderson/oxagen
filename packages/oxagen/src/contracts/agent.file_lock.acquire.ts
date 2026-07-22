import { z } from "zod";
import { registerCapability } from "../registry";

// Manual/introspectable acquire (docs/specs/agent-file-locking/plan.md §7).
// The SAME atomic acquire (the transactional Postgres lease, ADR-021 §5) that
// write_file/edit_file in packages/agent-engine/src/tools.ts call automatically
// for every coding-agent turn — exposed here so a caller (a dashboard, a
// script, a human debugging a stuck fleet) can hold or probe a lock directly,
// without running a turn.
export const agentFileLockAcquire = registerCapability({
  name: "acquire_file_lock",
  domain: "agent",
  description:
    "Acquire (or renew) an exclusive, TTL-bounded lock on a file so no two agents edit it concurrently. Fails with granted:false when a DIFFERENT agent already holds a live lock.",
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
    path: z.string().describe("File path (or naturalKey) to lock."),
    owner: z
      .string()
      .optional()
      .describe(
        "GitHub owner — combined with repo and path to derive a repository-scoped lease key.",
      ),
    repo: z.string().optional().describe("GitHub repo — see owner."),
    action: z
      .enum(["read", "write"])
      .optional()
      .describe('Action stored on the lease row (default "write").'),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .optional()
      .describe(
        "Lease length in ms (default 300000 = 5 minutes, mirrors IntentLedger's TTL). Capped at 1 hour.",
      ),
    agentId: z
      .string()
      .optional()
      .describe(
        "Identity to hold the lock as (default: the calling user/api-key id) — re-acquiring under the SAME agentId renews instead of conflicting.",
      ),
    executionId: z
      .string()
      .optional()
      .describe(
        "Correlates this lock for a later batch/manual release (default: a fresh id).",
      ),
  }),
  output: z.object({
    granted: z.boolean(),
    lockId: z.string().describe("Empty string when not granted."),
    heldBy: z
      .string()
      .nullable()
      .describe("The conflicting holder's agentId, when granted is false."),
    blockedUntil: z
      .number()
      .int()
      .nullable()
      .describe(
        "Epoch-ms the conflicting lock expires at, when granted is false.",
      ),
    fencingToken: z
      .number()
      .int()
      .nullable()
      .describe(
        "Monotonic per-resource fencing token for a granted lease (ADR-021 §5) — a takeover after expiry always issues a strictly higher token, so a stale holder's late write can be rejected. Null when not granted.",
      ),
  }),
});

export type AgentFileLockAcquireInput = z.output<
  typeof agentFileLockAcquire.input
>;
export type AgentFileLockAcquireOutput = z.output<
  typeof agentFileLockAcquire.output
>;
