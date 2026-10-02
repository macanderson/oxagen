// `stop_work_order`: a person asks the runtime to stop the run a send started.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderStop } from "@oxagen/oxagen/contracts/work.order.stop";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { stopWork } from "./lib/work-records/actions";

export interface WorkOrderStopDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const defaultWorkOrderStopDeps: WorkOrderStopDeps = {
  db: (fn) => withTenantDb(fn),
};

export function createWorkOrderStopHandler(deps: WorkOrderStopDeps): CapabilityHandler<typeof workOrderStop> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "stop");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderStop.name, () => deps.db((tx) => stopWork(tx, scope, actor, input)));
  };
}

export const workOrderStopHandler = createWorkOrderStopHandler(defaultWorkOrderStopDeps);
