// audit-exempt: read-only — answers one proposal's Context PR state; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_context_pr (ADR-061): the state machine as stored, the ledger length
// as the steering version, the promotion event once merged, the proposal as
// raised, and the close once rejected, each actor named by display name.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { contextPrUserIds, contextPrView } from "./context.steering.view";

export function createGetContextPrHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextPrGet> {
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
    const [ledger, merged, names] = await Promise.all([
      deps.store.ledgerLength(scope),
      deps.store.mergedRefs(row),
      deps.store.userNames(contextPrUserIds(row)),
    ]);
    return contextPrView(row, ledger, merged, names);
  };
}

export const getContextPrHandler = createGetContextPrHandler(steeringDeps());
