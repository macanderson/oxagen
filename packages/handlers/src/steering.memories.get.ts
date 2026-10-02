// steering.memories.get.ts: get_workspace_memory, one memory for the
// Memories tab's drawer (memory-collection spec, Memories tab; ADR-245).
//
// It reads the memory by its public id inside the caller's workspace, then
// its newest 100 uses and the memory PR that last cited it. A memory another
// workspace holds answers not_found, the same as one that does not exist.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringMemoriesGet,
  WORKSPACE_MEMORY_USES_MAX,
  type SteeringMemoriesGetOutput,
} from "@oxagen/oxagen/contracts/steering.memories.get";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { assertContractRole } from "./lib/capability-role-guard";
import { memoryView } from "./memory/workspace";
import type { WorkspaceMemoryStore } from "./memory/workspace-store";

export type SteeringMemoriesGetDeps = Pick<
  WorkspaceMemoryStore,
  "findMemories" | "listUses" | "findMemoryPr"
>;

/** The Postgres store, loaded on the first call so the handler module stays light. */
export const defaultSteeringMemoriesGetDeps: SteeringMemoriesGetDeps = {
  async findMemories(scope, publicIds) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.findMemories(scope, publicIds);
  },
  async listUses(scope, memoryId, limit) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.listUses(scope, memoryId, limit);
  },
  async findMemoryPr(scope, by) {
    const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
    return postgresWorkspaceMemoryStore.findMemoryPr(scope, by);
  },
};

export function createSteeringMemoriesGetHandler(
  deps: SteeringMemoriesGetDeps,
): CapabilityHandler<typeof steeringMemoriesGet> {
  return async (input, ctx): Promise<SteeringMemoriesGetOutput> => {
    await assertContractRole(steeringMemoriesGet, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const [row] = await deps.findMemories(scope, [input.memory_id]);
    if (row === undefined)
      throw new HandlerError({
        code: "not_found",
        reason: "memory_not_found",
        message: `This workspace holds no memory ${input.memory_id}.`,
      });
    const [{ uses, total }, pr] = await Promise.all([
      deps.listUses(scope, row.id, WORKSPACE_MEMORY_USES_MAX),
      row.memoryPr === null
        ? Promise.resolve(null)
        : deps.findMemoryPr(scope, { id: row.memoryPr.id }),
    ]);
    return {
      memory: {
        ...memoryView(row),
        run: row.runPublicId,
        evidence: row.evidence,
        applies_to: row.appliesTo,
        tools: row.tools,
        retired_at: row.retiredAt?.toISOString() ?? null,
        retired_reason: row.retiredReason,
      },
      uses: uses.map((use) => ({
        run: use.runPublicId,
        signal: use.signal,
        count: use.count,
        used_at: use.usedAt.toISOString(),
      })),
      uses_total: total,
      memory_pr:
        pr === null
          ? null
          : {
              id: pr.publicId,
              number: pr.number,
              url: pr.url,
              repository: pr.repository,
              branch: pr.branch,
              status: pr.status,
              opened_at: pr.openedAt.toISOString(),
              settled_at: pr.settledAt?.toISOString() ?? null,
            },
    };
  };
}

export const steeringMemoriesGetHandler = createSteeringMemoriesGetHandler(
  defaultSteeringMemoriesGetDeps,
);
