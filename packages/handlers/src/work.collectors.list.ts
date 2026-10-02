// work.collectors.list.ts: list_work_collectors, the workspace's work
// collectors with their health (P1-03, #5103).
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workCollectorsList,
  type WorkCollectorsListOutput,
} from "@oxagen/oxagen/contracts/work.collectors.list";
import { assertContractRole } from "./lib/capability-role-guard";
import type { CollectorView } from "./lib/work-intake/collectors";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkCollectorsListDeps {
  list(scope: WorkScope): Promise<CollectorView[]>;
}

/** The Postgres store, loaded on the first call. */
export const defaultWorkCollectorsListDeps: WorkCollectorsListDeps = {
  async list(scope) {
    const [{ withTenantDb }, { listCollectorViews }] = await Promise.all([
      import("@oxagen/database"),
      import("./lib/work-intake/collectors"),
    ]);
    return withTenantDb((tx) => listCollectorViews(tx, scope));
  },
};

export function createWorkCollectorsListHandler(deps: WorkCollectorsListDeps): CapabilityHandler<typeof workCollectorsList> {
  return async (_input, ctx): Promise<WorkCollectorsListOutput> => {
    await assertContractRole(workCollectorsList, ctx);
    return { collectors: await deps.list({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }) };
  };
}

export const workCollectorsListHandler = createWorkCollectorsListHandler(defaultWorkCollectorsListDeps);
