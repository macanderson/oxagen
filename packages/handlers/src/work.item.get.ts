// work.item.get.ts: get_work_item, one work item with everything a person
// decides on (P1-05, #5163).
//
// The role check runs first, before any read. The item is found by its
// workspace number (WI-12) or its public id (wi_…) in the caller's workspace
// only, and a deleted item reads as missing. A work record refusal reaches the
// caller in the shape the surfaces read (lib/work-records/errors.ts).
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { workItemGet, type WorkItemGetOutput } from "@oxagen/oxagen/contracts/work.item.get";
import { assertContractRole } from "./lib/capability-role-guard";
import type { WorkItemDetail } from "./lib/work-read/detail";
import type { WorkViewer } from "./lib/work-read/viewer";
import { itemNotFound } from "./lib/work-intake/handler-support";
import { refusingAs } from "./lib/work-records/errors";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkItemGetDeps {
  /** The item and its records, or null when the workspace has no such live item. */
  read(scope: WorkScope, item: string): Promise<WorkItemDetail | null>;
  /** What the caller may do on the Work pages. */
  viewer(ctx: CapabilityContext): Promise<WorkViewer>;
}

/** The Postgres reads, loaded on the first call. */
export const defaultWorkItemGetDeps: WorkItemGetDeps = {
  async read(scope, item) {
    return (await import("./lib/work-read/read")).readWorkItemDetail(scope, item);
  },
  async viewer(ctx) {
    return (await import("./lib/work-read/viewer")).workViewer(ctx);
  },
};

export function createWorkItemGetHandler(deps: WorkItemGetDeps): CapabilityHandler<typeof workItemGet> {
  return async (input, ctx): Promise<WorkItemGetOutput> => {
    await assertContractRole(workItemGet, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const detail = await refusingAs(workItemGet.name, () => deps.read(scope, input.item));
    if (detail === null) throw itemNotFound(input.item);
    return { ...detail, viewer: await deps.viewer(ctx) };
  };
}

export const workItemGetHandler = createWorkItemGetHandler(defaultWorkItemGetDeps);
