// `reject_work_order`: an enrolled host refuses a work order it cannot start
// (ADR-251).
//
// The host's key is checked as for claim_work_order, then the key's creator
// must still hold a role the contract grants. The send ends as rejected
// unless a run is already linked to it, and the agent is free again.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderReject, type WorkOrderRejectOutput } from "@oxagen/oxagen/contracts/work.order.reject";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertContractRole } from "./lib/capability-role-guard";
import { resolveEnrolledHost } from "./lib/tacho-host";
import { refusingAs } from "./lib/work-records/errors";
import { rejectWorkOrder } from "./lib/work-records/runtime";

export interface WorkOrderRejectDeps {
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  now: () => Date;
}

export const defaultWorkOrderRejectDeps: WorkOrderRejectDeps = {
  db: (fn) => withTenantDb(fn),
  now: () => new Date(),
};

export function createWorkOrderRejectHandler(deps: WorkOrderRejectDeps): CapabilityHandler<typeof workOrderReject> {
  return async (input, ctx): Promise<WorkOrderRejectOutput> => {
    const host = await deps.db((tx) => resolveEnrolledHost(workOrderReject.name, ctx, tx as never, input.host_enrollment_id));
    await assertContractRole(workOrderReject, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderReject.name, () =>
      deps.db((tx) =>
        rejectWorkOrder(
          tx,
          scope,
          { id: host.id, publicId: String(host.publicId), runtimeId: host.runtimeId, agentId: host.agentId },
          input.work_order_id,
          input.reason,
          deps.now(),
        ),
      ),
    );
  };
}

export const workOrderRejectHandler = createWorkOrderRejectHandler(defaultWorkOrderRejectDeps);
