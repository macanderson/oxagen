// steering.memories.dismiss.ts: dismiss_memories, a person sets memories
// aside or brings them back (memory-collection spec, Lifecycle; ADR-248).
//
// A dismissal moves each waiting or in_pr memory to dismissed and adds its
// statement hash to memory_rejections, so the curator does not propose the
// statement again without new evidence. A restore moves each dismissed
// memory back and removes the hashes its dismissal wrote. Both run in one
// transaction in workspace-store.ts.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringMemoriesDismiss,
  type SteeringMemoriesDismissOutput,
} from "@oxagen/oxagen/contracts/steering.memories.dismiss";
import { assertContractRole } from "./lib/capability-role-guard";
import type { WorkspaceMemoryStore } from "./memory/workspace-store";

export interface SteeringMemoriesDismissDeps
  extends Pick<WorkspaceMemoryStore, "dismissMemories" | "restoreMemories"> {
  now?(): Date;
}

/** The Postgres store, loaded on the first call so the handler module stays light. */
export const defaultSteeringMemoriesDismissDeps: SteeringMemoriesDismissDeps = {
  async dismissMemories(scope, publicIds, at) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.dismissMemories(scope, publicIds, at);
  },
  async restoreMemories(scope, publicIds) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.restoreMemories(scope, publicIds);
  },
};

export function createSteeringMemoriesDismissHandler(
  deps: SteeringMemoriesDismissDeps,
): CapabilityHandler<typeof steeringMemoriesDismiss> {
  return async (input, ctx): Promise<SteeringMemoriesDismissOutput> => {
    await assertContractRole(steeringMemoriesDismiss, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const result = input.restore
      ? await deps.restoreMemories(scope, input.memory_ids)
      : await deps.dismissMemories(
          scope,
          input.memory_ids,
          deps.now?.() ?? new Date(),
        );
    return {
      changed: result.changed,
      skipped: result.skipped.map((skip) => ({
        memory_id: skip.publicId,
        state: skip.state,
      })),
      rejections: result.rejections,
    };
  };
}

export const steeringMemoriesDismissHandler =
  createSteeringMemoriesDismissHandler(defaultSteeringMemoriesDismissDeps);
