// `reopen_work_item`: a person reopens a closed or done work item.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-251.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workItemReopen } from "@oxagen/oxagen/contracts/work.item.reopen";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { reopenWork } from "./lib/work-records/actions";

export interface WorkItemReopenDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const defaultWorkItemReopenDeps: WorkItemReopenDeps = {
  db: (fn) => withTenantDb(fn),
};

export function createWorkItemReopenHandler(deps: WorkItemReopenDeps): CapabilityHandler<typeof workItemReopen> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "reopen");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workItemReopen.name, () => deps.db((tx) => reopenWork(tx, scope, actor, input)));
  };
}

export const workItemReopenHandler = createWorkItemReopenHandler(defaultWorkItemReopenDeps);
