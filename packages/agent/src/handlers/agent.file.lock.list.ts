import { listFileLocks } from "@oxagen/ontology";
import type { CapabilityContext } from "../types";
import type {
  AgentFileLockListInput,
  AgentFileLockListOutput,
} from "@oxagen/oxagen/contracts/agent.file.lock.list";
import { toNaturalKey } from "../adapters/graph-sync";

export type { AgentFileLockListInput, AgentFileLockListOutput };

/**
 * Introspection: who holds what (docs/specs/agent-file-locking/plan.md §7).
 * Lists every currently-live lock in the tenant, optionally filtered to one
 * file — useful for debugging a stuck fleet.
 */
export async function agentFileLockListHandler(
  input: AgentFileLockListInput,
  _ctx: CapabilityContext,
): Promise<AgentFileLockListOutput> {
  const naturalKey = input.path ? toNaturalKey(input.path, input.owner, input.repo) : undefined;
  return listFileLocks({ naturalKey });
}
