// work.collectors.list.ts: list_work_collectors, the workspace's work
// collectors with their health (P1-03, #5103).
//
// The role check runs first, before any read. The viewer flag comes from the
// role check set_work_collector makes (lib/work-read/viewer.ts), so Work
// setup offers Add collector only to a person that write admits (#5181).
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import {
  workCollectorsList,
  type WorkCollectorsListOutput,
} from "@oxagen/oxagen/contracts/work.collectors.list";
import { assertContractRole } from "./lib/capability-role-guard";
import type { CollectorView } from "./lib/work-intake/collectors";
import type { WorkCollectorViewer } from "./lib/work-read/viewer";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkCollectorsListDeps {
  list(scope: WorkScope): Promise<CollectorView[]>;
  /** Whether the caller may change the workspace's collectors. */
  viewer(ctx: CapabilityContext): Promise<WorkCollectorViewer>;
}

/** The Postgres store and the role check, loaded on the first call. */
export const defaultWorkCollectorsListDeps: WorkCollectorsListDeps = {
  async list(scope) {
    const [{ withTenantDb }, { listCollectorViews }] = await Promise.all([
      import("@oxagen/database"),
      import("./lib/work-intake/collectors"),
    ]);
    return withTenantDb((tx) => listCollectorViews(tx, scope));
  },
  async viewer(ctx) {
    return (await import("./lib/work-read/viewer")).collectorViewer(ctx);
  },
};

export function createWorkCollectorsListHandler(deps: WorkCollectorsListDeps): CapabilityHandler<typeof workCollectorsList> {
  return async (_input, ctx): Promise<WorkCollectorsListOutput> => {
    await assertContractRole(workCollectorsList, ctx);
    const collectors = await deps.list({ orgId: ctx.orgId, workspaceId: ctx.workspaceId });
    return { collectors, viewer: await deps.viewer(ctx) };
  };
}

export const workCollectorsListHandler = createWorkCollectorsListHandler(defaultWorkCollectorsListDeps);
