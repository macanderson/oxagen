// audit-exempt: a dismissed proposal steered nothing and publishes nothing; the kernel capability.invoke_* audit records who dismissed it.
//
// dismiss_proposal (ADR-061): Owner/Admin (or the workspace Owner) rejects a
// proposal with a reason. A merged proposal is published and cannot be
// dismissed; retirement is its own Context PR and is outside this release.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

export function createDismissProposalHandler(
  deps: Pick<SteeringDeps, "store" | "now">,
): CapabilityHandler<typeof contextProposalDismiss> {
  return async (input, ctx) => {
    await assertOrgRole(ctx, { org: ["Owner", "Admin"], workspace: ["Owner"] });
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    if (row.status === "merged") {
      throw new HandlerError({
        code: "conflict",
        reason: "proposal_merged",
        message: "A merged proposal is published; retire the record instead",
      });
    }
    if (row.status === "rejected") {
      return { proposalId: row.publicId, status: "rejected" };
    }
    await deps.store.updateProposal(row.id, {
      status: "rejected",
      dismissedAt: deps.now(),
      dismissedReason: input.reason,
      updatedByUserId: ctx.userId ?? null,
    });
    return { proposalId: row.publicId, status: "rejected" };
  };
}

export const dismissProposalHandler = createDismissProposalHandler(
  steeringDeps(),
);
