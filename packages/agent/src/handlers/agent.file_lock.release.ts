import type { CapabilityContext } from "../types";
import type {
  AgentFileLockReleaseInput,
  AgentFileLockReleaseOutput,
} from "@oxagen/oxagen/contracts/agent.file_lock.release";
import { releaseFileLease } from "../file-lock/lease";

export type { AgentFileLockReleaseInput, AgentFileLockReleaseOutput };

/**
 * Admin/debug force-release (docs/specs/agent-file-locking/plan.md §5, §7).
 * Deliberately releases by lockId ONLY (no holder guard) — the whole point of
 * exposing this capability is clearing a lock a crashed agent left behind,
 * without needing that agent's internal identity. The contract gates this to
 * Owner/Admin only. Backed by the Postgres lease (ADR-021 §5).
 */
export async function agentFileLockReleaseHandler(
  input: AgentFileLockReleaseInput,
  ctx: CapabilityContext,
): Promise<AgentFileLockReleaseOutput> {
  return releaseFileLease({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    lockId: input.lockId,
  });
}
