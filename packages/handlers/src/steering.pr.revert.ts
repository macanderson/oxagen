// revert_steering_pr (#4449; steering-repo-spec, Steering PR flow: Revert).
// Open a steering PR that undoes a merged one.
//
// 1. Gate the caller on the contract's roles. An API key acts as its creator
//    (resolveActingUserId), so the MCP and CLI surfaces work.
// 2. Find the merged proposal. A proposal that is not merged, a governance
//    proposal, or one with no recorded pull request is refused.
// 3. Read the governance mode from the production branch and apply the
//    merge rule for that mode (mergeRefusal): a revert is a merge-class
//    action. No author is passed, because the caller opens the revert rather
//    than merging someone else's change. The revert PR's own merge checks the
//    approvals.
// 4. Read the merge commit and its first parent: what the production branch
//    held just before the merge.
// 5. openRevertPr writes every path the merge changed back to the parent's
//    version on `<prefix>/revert-<number>` and opens the PR. The ledger is
//    left alone, because it only grows.
// 6. In a steering repo, run the steering checks on the revert's head and
//    report the required "Oxagen steering" check. A legacy repository has no
//    required check, so nothing is reported there.
//
// The revert PR carries no proposal, so merge_steering_pr cannot merge it yet.
// It merges the way the other many-file steering PRs do today.
import {
  HandlerError,
  isHandlerError,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import {
  steeringPrRevert,
  type SteeringPrRevertOutput,
} from "@oxagen/oxagen/contracts/steering.pr.revert";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { assertSameHost } from "./context.steering.github";
import { mergeRefusal } from "./context.steering.policy";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import { logger } from "./logger";
import { openRevertPr, readSteeringLayout } from "./steering-repo/merge-queue";
import {
  reportSteeringChecks,
  workspaceSteeringPullRequestDeps,
  type ToolsPullRequestDeps,
} from "./tools.pr.open";

/** What the revert reads and writes through. */
export interface RevertDeps {
  steering: Pick<SteeringDeps, "store" | "github" | "roles">;
  /** The published index and names the steering checks read, and the clock. */
  checks: Pick<ToolsPullRequestDeps, "readIndex" | "readContext" | "now">;
}

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * True when the proposal names no repository, or names `repo` by its approved
 * name or its current one. A proposal merged in another repository has no
 * merge commit here to read.
 */
function sameRepository(
  name: string | null,
  repo: { fullName: string; currentFullName: string },
): boolean {
  if (!name) return true;
  const lower = name.toLowerCase();
  return (
    lower === repo.fullName.toLowerCase() ||
    lower === repo.currentFullName.toLowerCase()
  );
}

export function createRevertSteeringPrHandler(
  deps: RevertDeps,
): CapabilityHandler<typeof steeringPrRevert> {
  const { store, github, roles } = deps.steering;
  return async (input, ctx): Promise<SteeringPrRevertOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      contractRoleRequirement(steeringPrRevert),
    );
    if (!actingUserId) {
      // assertOrgRole refuses a call with no user first. This keeps the type.
      throw new HandlerError({
        code: "forbidden",
        reason: "no_principal",
        message:
          "Reverting a steering PR needs a signed-in user, or an API key whose creator is still a member",
      });
    }
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    const name = row.prUrl ?? row.publicId;
    if (row.kind === "governance") {
      throw refuse(
        "governance_proposal",
        `${name} changed the governance mode. Set the mode again in the workspace's governance settings to change it back.`,
      );
    }
    if (row.status !== "merged") {
      throw refuse(
        "not_merged",
        `${name} is ${row.status.replace(/_/g, " ")}. Only a merged steering PR can be reverted.`,
      );
    }
    const { prNumber, branch } = row;
    if (prNumber === null || !branch) {
      throw refuse(
        "pr_not_recorded",
        `Proposal ${row.publicId} has no recorded pull request, so there is nothing to revert`,
      );
    }

    const repo = await github.resolveRepository(scope);
    assertSameHost(repo, row.provider, row.prUrl);
    if (!sameRepository(row.repository, repo)) {
      throw refuse(
        "repository_changed",
        `${name} merged in ${row.repository}, and this workspace now steers through ${repo.fullName}. Revert it in ${row.repository} by hand.`,
      );
    }

    const layout = await readSteeringLayout(github, repo);
    const caller = {
      userId: actingUserId,
      orgRole: await roles.orgRole(ctx.orgId, actingUserId),
      workspaceRole: await roles.workspaceRole(
        ctx.orgId,
        ctx.workspaceId,
        actingUserId,
      ),
    };
    const refusal = mergeRefusal(layout.mode, caller, null);
    if (refusal) {
      throw new HandlerError({
        code: "forbidden",
        reason: refusal,
        message: `Governance mode ${layout.mode} does not let this caller merge, so it cannot revert a steering PR either (${refusal})`,
      });
    }

    const mergedCommit =
      row.mergedCommit ??
      (await github.getPullRequest(repo, prNumber)).mergeCommitSha;
    if (!mergedCommit) {
      throw refuse(
        "merge_commit_unknown",
        `${name} is merged, and neither Oxagen nor ${repo.provider} names its merge commit`,
      );
    }
    const [before] = await github.commitParents(repo, mergedCommit);
    if (!before) {
      throw refuse(
        "merge_commit_unknown",
        `${mergedCommit}, the merge commit of ${name}, has no parent, so there is no earlier version to go back to`,
      );
    }

    let opened: Awaited<ReturnType<typeof openRevertPr>>;
    try {
      opened = await openRevertPr({
        host: github,
        repo,
        number: prNumber,
        mergeCommit: mergedCommit,
        before,
        branch,
      });
    } catch (err) {
      if (isHandlerError(err) && err.reason === "proposal_branch_exists") {
        throw refuse(
          "revert_branch_exists",
          `A revert branch for #${prNumber} already exists in ${repo.fullName}. Merge or close its pull request, delete the branch, and then revert again.`,
        );
      }
      throw err;
    }

    const headSha = await github.branchHead(repo, opened.branch);
    let check: SteeringPrRevertOutput["check"] = null;
    if (layout.layout === "steering" && headSha !== null) {
      const base = await github.branchHead(repo, repo.defaultBranch);
      check = await reportSteeringChecks(deps.checks, {
        host: github,
        repo,
        scope,
        head: headSha,
        base: base ?? before,
        source: "steering.pr.revert",
      });
    }

    logger.info(
      {
        proposalId: row.publicId,
        reverted: prNumber,
        mergedCommit,
        before,
        revert: opened.number,
        branch: opened.branch,
        check,
        layout: layout.layout,
        workspaceId: ctx.workspaceId,
      },
      "steering.pr.revert: opened a revert steering PR",
    );

    return {
      proposalId: row.publicId,
      reverted: { number: prNumber, mergedCommit },
      pullRequest: {
        number: opened.number,
        url: opened.htmlUrl,
        branch: opened.branch,
        headSha,
      },
      check,
    };
  };
}

export const revertSteeringPrHandler = createRevertSteeringPrHandler({
  steering: steeringDeps(),
  checks: workspaceSteeringPullRequestDeps,
});
