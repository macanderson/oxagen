import { forceReleaseFileLock } from "@oxagen/ontology";
import type { CapabilityContext } from "../types";
import type {
  AgentFileLockReleaseInput,
  AgentFileLockReleaseOutput,
} from "@oxagen/oxagen/contracts/agent.file.lock.release";

export type { AgentFileLockReleaseInput, AgentFileLockReleaseOutput };

/**
 * Admin/debug force-release (docs/specs/agent-file-locking/plan.md §5, §7).
 * Deliberately uses `forceReleaseFileLock` (matches by lockId ONLY) rather
 * than `releaseFileLock` (which also checks the holder's agentId) — the
 * whole point of exposing this capability is clearing a lock a crashed
 * agent left behind, without needing that agent's internal identity. The
 * contract gates this to Owner/Admin only.
 */
export async function agentFileLockReleaseHandler(
  input: AgentFileLockReleaseInput,
  _ctx: CapabilityContext,
): Promise<AgentFileLockReleaseOutput> {
  return forceReleaseFileLock({ lockId: input.lockId });
}
