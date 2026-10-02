// `return_work_order`: a person returns a send's result to the agent, and by default sends it again.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-251.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderReturn } from "@oxagen/oxagen/contracts/work.order.return";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import type { GovernanceMode } from "@oxagen/work/records";
import { readWorkGovernanceMode } from "./lib/work-records/governance";
import type { WorkScope } from "./lib/work-records/store";
import { returnWork } from "./lib/work-records/actions";

export interface WorkOrderReturnDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** The workspace's governance mode, or null when it has no steering repository. Fails closed. */
  governanceMode: (scope: WorkScope) => Promise<GovernanceMode>;
}

export const defaultWorkOrderReturnDeps: WorkOrderReturnDeps = {
  db: (fn) => withTenantDb(fn),
  governanceMode: (scope) => readWorkGovernanceMode(scope),
};

export function createWorkOrderReturnHandler(deps: WorkOrderReturnDeps): CapabilityHandler<typeof workOrderReturn> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "return");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderReturn.name, async () => {
      // A return that sends again checks the same duties as a send, so it reads the mode first.
      const governanceMode = input.resend ? await deps.governanceMode(scope) : null;
      return deps.db((tx) => returnWork(tx, scope, actor, input, governanceMode));
    });
  };
}

export const workOrderReturnHandler = createWorkOrderReturnHandler(defaultWorkOrderReturnDeps);
