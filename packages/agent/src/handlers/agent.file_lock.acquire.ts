import type { CapabilityContext } from "../types";
import type {
  AgentFileLockAcquireInput,
  AgentFileLockAcquireOutput,
} from "@oxagen/oxagen/contracts/agent.file_lock.acquire";
import { toNaturalKey } from "../adapters/natural-key";
import { acquireFileLease } from "../file-lock/lease";

export type { AgentFileLockAcquireInput, AgentFileLockAcquireOutput };

/**
 * Manual/introspectable acquire (docs/specs/agent-file-locking/plan.md §7).
 * Runs the SAME transactional Postgres lease (ADR-021 §5) that write_file/
 * edit_file acquire automatically inside every coding-agent turn — invoked
 * directly here so a dashboard, script, or human debugging a stuck fleet can
 * hold or probe a lock without running a turn.
 */
export async function agentFileLockAcquireHandler(
  input: AgentFileLockAcquireInput,
  ctx: CapabilityContext,
): Promise<AgentFileLockAcquireOutput> {
  const resourceKey = toNaturalKey(input.path, input.owner, input.repo);
  const holder =
    input.agentId ?? ctx.userId ?? ctx.apiKeyId ?? `manual:${ctx.requestId}`;
  const executionId = input.executionId ?? crypto.randomUUID();

  const result = await acquireFileLease({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    resourceKeys: [resourceKey],
    holder,
    executionId,
    action: input.action,
    ttlMs: input.ttlMs,
  });

  const lease = result.acquired[0];
  if (lease) {
    return {
      granted: true,
      lockId: lease.lockId,
      heldBy: null,
      blockedUntil: null,
      fencingToken: lease.fencingToken,
    };
  }
  const conflict = result.conflicts[0];
  return {
    granted: false,
    lockId: "",
    heldBy: conflict?.holder ?? null,
    blockedUntil: conflict?.expiresAt ?? null,
    fencingToken: null,
  };
}
