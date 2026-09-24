// audit-exempt: a dismissed proposal steered nothing and publishes nothing; the kernel capability.invoke_* audit records who dismissed it.
//
// dismiss_proposal (ADR-061): Owner/Admin (or the workspace Owner) rejects a
// proposal with a reason; the acting user is the signed-in user or the
// creator of the API key (resolveActingUserId). A proposal that started a Context PR has the PR
// closed and its branch deleted first, so the next proposal on the lineage
// opens a fresh branch and PR; that includes a proposal whose open failed
// after GitHub opened the PR, whose PR is found on its branch and named in
// its body. A merged
// proposal is published and cannot be dismissed; retirement is its own
// Context PR and is outside this release. The `rejected` write applies only
// to a proposal still short of `merged`, so a merge that published while
// GitHub was being called keeps its proposal.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import type { ProposalStatus } from "@oxagen/oxagen/contracts/context.steering.shared";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { bodyNamesProposal } from "./context.steering.view";

const DISMISSABLE: readonly ProposalStatus[] = [
  "proposed",
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
];

export function createDismissProposalHandler(
  deps: Pick<SteeringDeps, "store" | "github" | "now">,
): CapabilityHandler<typeof contextProposalDismiss> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
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
    // Without a PR number the branch is this proposal's only while no other
    // proposal on the lineage has recorded a PR on it, and a PR found on it
    // only when its body names this proposal.
    if (
      row.branch &&
      (row.prNumber !== null ||
        !(await deps.store.findOpenPrOnLineage(scope, row.lineageId, row.id)))
    ) {
      const repo = await deps.github.resolveRepository(scope);
      // A PR opened on another host than the one the workspace now binds is
      // left alone there: its number means nothing on this host, and closing
      // by it would close an unrelated pull request or merge request. The
      // proposal is still rejected here.
      const sameHost =
        row.prNumber === null || (row.provider ?? "github") === repo.provider;
      const found =
        row.prNumber === null
          ? await deps.github.findOpenPullRequest(repo, {
              head: row.branch,
              base: repo.defaultBranch,
            })
          : null;
      if (sameHost && (!found || bodyNamesProposal(found.body, row.publicId))) {
        const prNumber = row.prNumber ?? found?.number ?? null;
        if (prNumber !== null)
          await deps.github.closePullRequest(repo, prNumber);
        await deps.github.deleteBranch(repo, row.branch);
      }
    }
    try {
      await deps.store.updateProposal(
        row.id,
        {
          status: "rejected",
          dismissedAt: deps.now(),
          dismissedReason: input.reason,
          updatedById: actingUserId,
        },
        DISMISSABLE,
      );
    } catch (err) {
      // Another dismissal landed first; this one answers as it did.
      if (err instanceof HandlerError && err.reason === "proposal_rejected")
        return { proposalId: row.publicId, status: "rejected" };
      throw err;
    }
    return { proposalId: row.publicId, status: "rejected" };
  };
}

export const dismissProposalHandler = createDismissProposalHandler(
  steeringDeps(),
);
