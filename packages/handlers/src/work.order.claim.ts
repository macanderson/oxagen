// `claim_work_order`: an enrolled host claims a work order before it starts a
// run for it (ADR-251).
//
// The host's key is checked the way every Tacho control call checks it
// (resolveEnrolledHost: the key belongs to the enrollment the call names, and
// the host is not revoked or expired), then the key's creator must still hold
// a role the contract grants. The claim itself is checked against the send:
// the host must be the target agent's host on the target runtime, the send
// must not have ended, and one host holds a send (lib/work-records/runtime.ts).
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderClaim, type WorkOrderClaimOutput } from "@oxagen/oxagen/contracts/work.order.claim";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertContractRole } from "./lib/capability-role-guard";
import { resolveEnrolledHost } from "./lib/tacho-host";
import { refusingAs } from "./lib/work-records/errors";
import { claimWorkOrder } from "./lib/work-records/runtime";

export interface WorkOrderClaimDeps {
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  now: () => Date;
}

export const defaultWorkOrderClaimDeps: WorkOrderClaimDeps = {
  db: (fn) => withTenantDb(fn),
  now: () => new Date(),
};

export function createWorkOrderClaimHandler(deps: WorkOrderClaimDeps): CapabilityHandler<typeof workOrderClaim> {
  return async (input, ctx): Promise<WorkOrderClaimOutput> => {
    const host = await deps.db((tx) => resolveEnrolledHost(workOrderClaim.name, ctx, tx as never, input.host_enrollment_id));
    await assertContractRole(workOrderClaim, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const claim = await refusingAs(workOrderClaim.name, () =>
      deps.db((tx) =>
        claimWorkOrder(
          tx,
          scope,
          { id: host.id, publicId: String(host.publicId), runtimeId: host.runtimeId, agentId: host.agentId },
          input.work_order_id,
          deps.now(),
        ),
      ),
    );
    return {
      repeat: claim.repeat,
      work_order: {
        id: claim.orderPublicId,
        key: claim.order.key,
        send: claim.order.send,
        item_id: claim.itemPublicId,
        item_number: claim.itemNumber,
        brief_revision: claim.order.briefRevision,
        repository: claim.repository,
        agent_id: claim.agentPublicId,
        harness: claim.harness,
      },
      prompt: claim.prompt,
    };
  };
}

export const workOrderClaimHandler = createWorkOrderClaimHandler(defaultWorkOrderClaimDeps);
