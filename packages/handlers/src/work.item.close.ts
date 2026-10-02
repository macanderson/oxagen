// `close_work_item`: a person closes a work item without finishing it.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workItemClose } from "@oxagen/oxagen/contracts/work.item.close";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { closeWork } from "./lib/work-records/actions";

export interface WorkItemCloseDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const defaultWorkItemCloseDeps: WorkItemCloseDeps = {
  db: (fn) => withTenantDb(fn),
};

export function createWorkItemCloseHandler(deps: WorkItemCloseDeps): CapabilityHandler<typeof workItemClose> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "close");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workItemClose.name, () => deps.db((tx) => closeWork(tx, scope, actor, input)));
  };
}

export const workItemCloseHandler = createWorkItemCloseHandler(defaultWorkItemCloseDeps);
