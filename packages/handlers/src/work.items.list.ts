// work.items.list.ts: list_work_items, the workspace's work items as the Work
// page's four tabs show them (P1-05, #5163).
//
// The role check runs first, before any read. Each row is reduced from the
// item's facts on the server (lib/work-read). The viewer flags come from the
// same role check each Work action makes.
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { workItemsList, type WorkItemsListOutput } from "@oxagen/oxagen/contracts/work.items.list";
import { assertContractRole } from "./lib/capability-role-guard";
import type { WorkItemsPage } from "./lib/work-read/read";
import type { WorkViewer } from "./lib/work-read/viewer";
import { refusingAs } from "./lib/work-records/errors";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkItemsListDeps {
  /** The newest `limit` items, each reduced from its facts. */
  list(scope: WorkScope, limit: number): Promise<WorkItemsPage>;
  /** What the caller may do on the Work pages. */
  viewer(ctx: CapabilityContext): Promise<WorkViewer>;
}

/** The Postgres reads, loaded on the first call. */
export const defaultWorkItemsListDeps: WorkItemsListDeps = {
  async list(scope, limit) {
    return (await import("./lib/work-read/read")).readWorkItemRows(scope, limit);
  },
  async viewer(ctx) {
    return (await import("./lib/work-read/viewer")).workViewer(ctx);
  },
};

export function createWorkItemsListHandler(deps: WorkItemsListDeps): CapabilityHandler<typeof workItemsList> {
  return async (input, ctx): Promise<WorkItemsListOutput> => {
    await assertContractRole(workItemsList, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workItemsList.name, async () => {
      const page = await deps.list(scope, input.limit);
      return { items: page.items, truncated: page.truncated, viewer: await deps.viewer(ctx) };
    });
  };
}

export const workItemsListHandler = createWorkItemsListHandler(defaultWorkItemsListDeps);
