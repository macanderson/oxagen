// steering.memories.promote.ts: promote_memories, a person's draft steering
// records from selected memories (memory-collection spec, Promotion;
// ADR-206, ADR-248).
//
// The handler checks the caller's role, then hands the drafts to
// memory/promote.ts, which writes them to the open memory PR or opens one on
// today's memory branch through the curator's path.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringMemoriesPromote,
  type SteeringMemoriesPromoteOutput,
} from "@oxagen/oxagen/contracts/steering.memories.promote";
import { assertContractRole } from "./lib/capability-role-guard";
import type { PromoteDeps } from "./memory/promote";
import { actingAuthor } from "./steering-repo/pr-proposal";

/** The deps a call runs with. A function, so each call gets a fresh steering host. */
export type SteeringMemoriesPromoteDeps = () => Promise<PromoteDeps>;

/** The steering host and the two Postgres memory stores, loaded on the first call. */
export const defaultSteeringMemoriesPromoteDeps: SteeringMemoriesPromoteDeps =
  async () => {
    const [
      { createSteeringHost },
      { postgresMemoryStore },
      { postgresWorkspaceMemoryStore },
      { postgresSteeringStore },
    ] = await Promise.all([
      import("./context.steering.host"),
      import("./memory/store"),
      import("./memory/workspace-store"),
      import("./context.steering.store"),
    ]);
    return {
      host: createSteeringHost(),
      store: postgresMemoryStore,
      workspace: postgresWorkspaceMemoryStore,
      proposals: postgresSteeringStore,
      now: () => new Date(),
    };
  };

export function createSteeringMemoriesPromoteHandler(
  deps: SteeringMemoriesPromoteDeps,
): CapabilityHandler<typeof steeringMemoriesPromote> {
  return async (input, ctx): Promise<SteeringMemoriesPromoteOutput> => {
    await assertContractRole(steeringMemoriesPromote, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { promoteMemories } = await import("./memory/promote");
    const result = await promoteMemories(await deps(), scope, {
      drafts: input.drafts,
      sameText: input.same_text,
      author: await actingAuthor(ctx),
    });
    return {
      pull_request: result.pullRequest,
      records: result.records.map((record) => ({
        path: record.path,
        lineage: record.lineage,
        kind: record.kind,
        force: record.force,
        effect: record.effect,
        memory_ids: record.memoryIds,
      })),
      skipped: result.skipped.map((skip) => ({
        memory_id: skip.memoryId,
        reason: skip.reason,
      })),
    };
  };
}

export const steeringMemoriesPromoteHandler =
  createSteeringMemoriesPromoteHandler(defaultSteeringMemoriesPromoteDeps);
