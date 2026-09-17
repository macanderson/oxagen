// audit-exempt: read-only — lists the workspace's proposals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// list_proposals (ADR-061): newest first, with the PR and the check tally
// once a Context PR is open.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { proposalView } from "./context.steering.view";

export function createListProposalsHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextProposalList> {
  return async (input, ctx) => {
    const { rows, total } = await deps.store.listProposals(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      { status: input.status, lineageId: input.lineageId },
      { limit: input.limit, offset: input.offset },
    );
    return { proposals: rows.map(proposalView), total };
  };
}

export const listProposalsHandler = createListProposalsHandler(steeringDeps());
