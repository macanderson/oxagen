import type { CapabilityContext } from "../types";
import type {
  AgentFileLockListInput,
  AgentFileLockListOutput,
} from "@oxagen/oxagen/contracts/agent.file_lock.list";
import { toFileResourceKey } from "../file-lock/resource-key";
import { listFileLeases } from "../file-lock/lease";

export type { AgentFileLockListInput, AgentFileLockListOutput };

/**
 * Introspection: who holds what (docs/specs/agent-file-locking/plan.md §7).
 * Lists every currently-live lock in the tenant, optionally filtered to one
 * file — useful for debugging a stuck fleet. Backed by the Postgres lease
 * (ADR-021 §5); `naturalKey` is preserved in the output shape as the resource
 * key so the contract's consumers are unchanged.
 */
export async function agentFileLockListHandler(
  input: AgentFileLockListInput,
  ctx: CapabilityContext,
): Promise<AgentFileLockListOutput> {
  const resourceKey = input.path
    ? toFileResourceKey(input.path, input.owner, input.repo)
    : undefined;
  const { leases } = await listFileLeases({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    resourceKey,
  });
  return {
    locks: leases.map((lease) => ({
      lockId: lease.lockId,
      naturalKey: lease.resourceKey,
      agentId: lease.holder,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      workspaceId: ctx.workspaceId,
      action: lease.action,
      executionId: lease.executionId,
    })),
  };
}
