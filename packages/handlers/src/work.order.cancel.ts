// `cancel_work_order`: a person withdraws a send no runtime has claimed.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderCancel } from "@oxagen/oxagen/contracts/work.order.cancel";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { cancelWork } from "./lib/work-records/actions";

export interface WorkOrderCancelDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const defaultWorkOrderCancelDeps: WorkOrderCancelDeps = {
  db: (fn) => withTenantDb(fn),
};

export function createWorkOrderCancelHandler(deps: WorkOrderCancelDeps): CapabilityHandler<typeof workOrderCancel> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "withdraw");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderCancel.name, () => deps.db((tx) => cancelWork(tx, scope, actor, input)));
  };
}

export const workOrderCancelHandler = createWorkOrderCancelHandler(defaultWorkOrderCancelDeps);
