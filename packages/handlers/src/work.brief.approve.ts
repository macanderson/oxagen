// `approve_work_brief`: a person approves the latest brief for the item's current revision.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-251.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workBriefApprove } from "@oxagen/oxagen/contracts/work.brief.approve";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { approveWorkBrief } from "./lib/work-records/actions";

export interface WorkBriefApproveDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const defaultWorkBriefApproveDeps: WorkBriefApproveDeps = {
  db: (fn) => withTenantDb(fn),
};

export function createWorkBriefApproveHandler(deps: WorkBriefApproveDeps): CapabilityHandler<typeof workBriefApprove> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "approve_brief");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workBriefApprove.name, () => deps.db((tx) => approveWorkBrief(tx, scope, actor, input)));
  };
}

export const workBriefApproveHandler = createWorkBriefApproveHandler(defaultWorkBriefApproveDeps);
