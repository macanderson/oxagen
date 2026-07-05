import { acquireFileLock } from "@oxagen/ontology";
import type { CapabilityContext } from "../types";
import type {
  AgentFileLockAcquireInput,
  AgentFileLockAcquireOutput,
} from "@oxagen/oxagen/contracts/agent.file.lock.acquire";
import { toNaturalKey } from "../adapters/graph-sync";

export type { AgentFileLockAcquireInput, AgentFileLockAcquireOutput };

/**
 * Manual/introspectable acquire (docs/specs/agent-file-locking/plan.md §7).
 * Runs the SAME atomic Cypher (@oxagen/ontology's acquireFileLock) that
 * write_file/edit_file acquire automatically inside every coding-agent turn
 * — invoked directly here so a dashboard, script, or human debugging a
 * stuck fleet can hold or probe a lock without running a turn.
 */
export async function agentFileLockAcquireHandler(
  input: AgentFileLockAcquireInput,
  ctx: CapabilityContext,
): Promise<AgentFileLockAcquireOutput> {
  const naturalKey = toNaturalKey(input.path, input.owner, input.repo);
  const agentId = input.agentId ?? ctx.userId ?? ctx.apiKeyId ?? `manual:${ctx.requestId}`;
  const executionId = input.executionId ?? crypto.randomUUID();

  const result = await acquireFileLock({
    naturalKey,
    agentId,
    executionId,
    workspaceId: ctx.workspaceId,
    action: input.action,
    ttlMs: input.ttlMs,
  });

  return result;
}
