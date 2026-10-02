// audit-exempt: the approval row is the record of who approved which head and when, and the merge's ledger line and Oxagen-Approved-By trailer name every approver it counted; the kernel's capability.invoke_* audit records the call.
//
// approve_steering_pr (#4518, ADR-267): a person approves a steering PR at
// its current head.
//
// Under the team and regulated governance modes, merge_steering_pr lands a
// steering PR only after a workspace member other than the author approves
// it at the head that merges (steering-repo/merge-queue.ts, mergeApproval).
// The Oxagen GitHub App opens every steering PR, and GitHub refuses an app's
// approving review of a pull request it opened, so this approval is a row in
// agent.steering_pr_approvals. The merge counts those rows beside the host's
// approvals, under the same rule.
//
// Flow:
//   1. Refuse an agent run (`agent_run`), and any call that is not a person's
//      session (`no_principal`). API-key auth sets the call's user to the
//      person who made the key, so the gate refuses `apiKeyId` itself, as
//      lib/work-records/actor.ts does: a key an agent holds, an `oxagen login`
//      key included, could otherwise approve a change it proposed. Then check
//      the contract's roles.
//   2. Refuse what has nothing to approve: no such proposal, a merged or
//      dismissed one, and one whose steering PR is not open yet.
//   3. Refuse the proposal's author (`author_cannot_approve`), as the merge
//      would not count the approval.
//   4. Read the PR on the host once. Refuse a PR the host merged or closed
//      (`pr_closed`), and one whose head moved off the head the checks ran on:
//      the person would approve a head nobody checked.
//   5. Record the approval at that head. Approving the same head again
//      records nothing new.
//
// No governance mode is refused. The mode on the row is the one read when the
// PR opened, and the merge reads it again, so an approval given under solo
// still counts if the mode becomes team before the merge.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringPrApprove,
  type SteeringPrApproveOutput,
} from "@oxagen/oxagen/contracts/steering.pr.approve";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { assertSameHost } from "./context.steering.github";
import { proposalMoved } from "./context.steering.store";
import { assertContractRole } from "./lib/capability-role-guard";

export interface ApproveSteeringPrDeps
  extends Pick<SteeringDeps, "store" | "github"> {
  /** The handler-side role check (lib/capability-role-guard.ts). */
  assertRole(
    ctx: Parameters<CapabilityHandler<typeof steeringPrApprove>>[1],
  ): Promise<void>;
}

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

export function createApproveSteeringPrHandler(
  deps: ApproveSteeringPrDeps,
): CapabilityHandler<typeof steeringPrApprove> {
  return async (input, ctx): Promise<SteeringPrApproveOutput> => {
    if (ctx.agentRun) {
      throw new HandlerError({
        code: "forbidden",
        reason: "agent_run",
        message:
          "An agent run cannot approve a steering PR. A person approves it in Oxagen.",
      });
    }
    // API-key auth sets userId to the key's creator, so a missing user is not
    // the only call to refuse.
    const userId = ctx.apiKeyId ? null : (ctx.userId ?? null);
    if (!userId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_principal",
        message:
          "Approving a steering PR needs a person signed in to Oxagen. An API key cannot approve one.",
      });
    }
    await deps.assertRole(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    if (row.status === "merged" || row.status === "rejected") {
      throw proposalMoved(row.publicId, row.status);
    }
    const headSha = row.headSha;
    if (row.status === "proposed" || row.prNumber === null || !headSha) {
      throw refuse(
        "pr_not_open",
        `${row.publicId} has no open steering PR to approve. Open its steering PR first.`,
      );
    }
    if (row.createdById !== null && row.createdById === userId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "author_cannot_approve",
        message: `You raised ${row.publicId}, so the merge would not count your approval. Ask another workspace member to approve it.`,
      });
    }

    const repo = await deps.github.resolveRepository(scope);
    assertSameHost(repo, row.provider, row.prUrl);
    const pr = await deps.github.getPullRequest(repo, row.prNumber);
    if (pr.merged || !pr.open) {
      throw refuse(
        "pr_closed",
        `${row.prUrl ?? row.publicId} is ${pr.merged ? "merged" : "closed"} on ${repo.provider === "gitlab" ? "GitLab" : "GitHub"}, so there is nothing to approve.`,
      );
    }
    if (pr.headSha !== headSha) {
      throw refuse(
        "head_moved",
        `${row.prUrl ?? row.publicId} moved to ${pr.headSha ?? "no commit"} after the checks ran on ${headSha}. Run the checks again, then approve the new head.`,
      );
    }

    await deps.store.recordApproval({
      scope,
      proposalId: row.id,
      userId,
      commitSha: headSha,
    });
    const atHead = (await deps.store.listApprovals(scope, row.id)).filter(
      (approval) => approval.commitSha === headSha,
    );
    return {
      proposalId: row.publicId,
      headSha,
      approvals: new Set(atHead.map((approval) => approval.userId)).size,
    };
  };
}

export const approveSteeringPrHandler = createApproveSteeringPrHandler({
  ...steeringDeps(),
  // The guard answers the role it found. The handler needs only the refusal.
  assertRole: async (ctx) => {
    await assertContractRole(steeringPrApprove, ctx);
  },
});
