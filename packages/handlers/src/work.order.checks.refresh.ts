// `refresh_work_order_checks`: Oxagen reads a send's pull request checks from GitHub again and records them.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOrderChecksRefresh } from "@oxagen/oxagen/contracts/work.order.checks.refresh";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { type EvidenceReader, githubEvidenceReader } from "./lib/work-records/evidence";
import { refreshWorkChecks } from "./lib/work-records/accept";

export interface WorkOrderChecksRefreshDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Reads the pull request, the required checks, and the checks from GitHub. */
  reader: EvidenceReader;
  now: () => Date;
}

export const defaultWorkOrderChecksRefreshDeps: WorkOrderChecksRefreshDeps = {
  db: (fn) => withTenantDb(fn),
  reader: githubEvidenceReader,
  now: () => new Date(),
};

export function createWorkOrderChecksRefreshHandler(deps: WorkOrderChecksRefreshDeps): CapabilityHandler<typeof workOrderChecksRefresh> {
  return async (input, ctx) => {
    // Read checks takes the role Accept takes: it exists to support acceptance.
    await assertWorkActor(ctx, "accept");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOrderChecksRefresh.name, () => refreshWorkChecks(deps, scope, input));
  };
}

export const workOrderChecksRefreshHandler = createWorkOrderChecksRefreshHandler(defaultWorkOrderChecksRefreshDeps);
