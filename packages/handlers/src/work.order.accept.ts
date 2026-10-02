// `accept_work_order`: a person accepts a send's result on the pull request's head commit, after Oxagen reads the required checks again.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderAccept } from "@oxagen/oxagen/contracts/work.order.accept";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { type EvidenceReader, githubEvidenceReader } from "./lib/work-records/evidence";
import { acceptWork } from "./lib/work-records/accept";

export interface WorkOrderAcceptDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Reads the pull request, the required checks, and the checks from GitHub. */
  reader: EvidenceReader;
  now: () => Date;
}

export const defaultWorkOrderAcceptDeps: WorkOrderAcceptDeps = {
  db: (fn) => withTenantDb(fn),
  reader: githubEvidenceReader,
  now: () => new Date(),
};

export function createWorkOrderAcceptHandler(deps: WorkOrderAcceptDeps): CapabilityHandler<typeof workOrderAccept> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "accept");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderAccept.name, () =>
      acceptWork(deps, scope, actor, input),
    );
  };
}

export const workOrderAcceptHandler = createWorkOrderAcceptHandler(defaultWorkOrderAcceptDeps);
