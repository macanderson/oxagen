// audit-exempt: read-only — answers one proposal's steering PR state; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_steering_pr (ADR-061): the state machine as stored, the ledger length
// as the steering version, the promotion event once merged, the proposal as
// raised, and the close once rejected, each actor named by display name.
// It also answers the managed-block findings the latest check run stored and
// the approvals given in Oxagen at the checked head (#4518, ADR-267). Every
// field comes from Postgres, so the page's poll reads no host.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringPrGet } from "@oxagen/oxagen/contracts/steering.pr.get";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { steeringPrUserIds, steeringPrView } from "./context.steering.view";

export function createGetSteeringPrHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof steeringPrGet> {
  return async (input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    const [ledger, merged, names, approvals] = await Promise.all([
      deps.store.ledgerLength(scope),
      deps.store.mergedRefs(row),
      deps.store.userNames(scope, steeringPrUserIds(row)),
      row.headSha === null
        ? Promise.resolve([])
        : deps.store.listApprovals(scope, row.id),
    ]);
    // An approval counts only at the head the checks ran on, and each
    // person once.
    const atHead = new Set(
      approvals
        .filter((approval) => approval.commitSha === row.headSha)
        .map((approval) => approval.userId),
    );
    return {
      ...steeringPrView(row, ledger, merged, names),
      findings: row.checkFindings ?? [],
      approvals: atHead.size,
    };
  };
}

export const getSteeringPrHandler = createGetSteeringPrHandler(steeringDeps());
