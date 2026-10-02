// `send_work_order`: a person sends a work item's approved brief to an agent they operate.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderSend } from "@oxagen/oxagen/contracts/work.order.send";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import type { GovernanceMode } from "@oxagen/work/records";
import { readWorkGovernanceMode } from "./lib/work-records/governance";
import type { WorkScope } from "./lib/work-records/store";
import { sendOutput, sendWork } from "./lib/work-records/actions";

export interface WorkOrderSendDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** The workspace's governance mode, or null when it has no steering repository. Fails closed. */
  governanceMode: (scope: WorkScope) => Promise<GovernanceMode>;
}

export const defaultWorkOrderSendDeps: WorkOrderSendDeps = {
  db: (fn) => withTenantDb(fn),
  governanceMode: (scope) => readWorkGovernanceMode(scope),
};

export function createWorkOrderSendHandler(deps: WorkOrderSendDeps): CapabilityHandler<typeof workOrderSend> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "send");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderSend.name, async () => {
      // Read before the transaction: it reads the steering repository over the network.
      const governanceMode = await deps.governanceMode(scope);
      const result = await deps.db((tx) => sendWork(tx, scope, actor, input, governanceMode));
      return sendOutput(result);
    });
  };
}

export const workOrderSendHandler = createWorkOrderSendHandler(defaultWorkOrderSendDeps);
