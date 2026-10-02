// steering.memories.list.ts: list_workspace_memories, the Memories tab's
// ranked list (memory-collection spec, Memories tab; ADR-245).
//
// The store reads the 2,000 highest ranked memories that match the filters,
// in the curator's order: uses, then the newest use, then the newest capture.
// workspace.ts groups the memories that say the same thing and cuts the page
// of groups. The tab's count is the workspace's waiting memories, whatever
// the filters.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringMemoriesList,
  WORKSPACE_MEMORIES_GROUPED_MAX,
  type SteeringMemoriesListOutput,
} from "@oxagen/oxagen/contracts/steering.memories.list";
import { assertContractRole } from "./lib/capability-role-guard";
import { groupPage } from "./memory/workspace";
import type { WorkspaceMemoryStore } from "./memory/workspace-store";

export type SteeringMemoriesListDeps = Pick<
  WorkspaceMemoryStore,
  "listMemories" | "countWaiting"
>;

/** The Postgres store, loaded on the first call so the handler module stays light. */
export const defaultSteeringMemoriesListDeps: SteeringMemoriesListDeps = {
  async listMemories(scope, filter, max) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.listMemories(scope, filter, max);
  },
  async countWaiting(scope) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.countWaiting(scope);
  },
};

export function createSteeringMemoriesListHandler(
  deps: SteeringMemoriesListDeps,
): CapabilityHandler<typeof steeringMemoriesList> {
  return async (input, ctx): Promise<SteeringMemoriesListOutput> => {
    await assertContractRole(steeringMemoriesList, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const [{ rows, total }, waiting] = await Promise.all([
      deps.listMemories(
        scope,
        {
          states: input.states,
          harness: input.harness,
          agent: input.agent,
          repository: input.repository,
          type: input.type,
        },
        WORKSPACE_MEMORIES_GROUPED_MAX,
      ),
      deps.countWaiting(scope),
    ]);
    const page = groupPage(rows, input.offset, input.limit);
    return {
      groups: page.groups,
      total_groups: page.total,
      total_memories: Math.min(total, WORKSPACE_MEMORIES_GROUPED_MAX),
      truncated: total > WORKSPACE_MEMORIES_GROUPED_MAX,
      waiting,
    };
  };
}

export const steeringMemoriesListHandler = createSteeringMemoriesListHandler(
  defaultSteeringMemoriesListDeps,
);
