// audit-exempt: the commit lands on a steering PR's branch and publishes nothing (nothing steers until merge_context_pr, which emits steering.published); the kernel's capability.invoke_* audit records the call.
//
// restore_managed_block (#4518; steering-repo-spec, Managed blocks): put
// Oxagen's managed block back in AGENTS.md, CLAUDE.md, or README.md on an
// open steering PR's branch.
//
// Flow:
//   1. Refuse what cannot take the commit: no such proposal, a PR that is not
//      open, a governance PR (its checks are not the record checks), a merge
//      in progress, a repository on another host, a PR that no longer targets
//      the production branch, and a repository that is not a steering repo.
//   2. Read the file on the production branch and at the branch's head, and
//      build the file with the production block restored
//      (steering-repo/managed-block.ts). A block that already matches is
//      refused `block_intact`, and a production file with no block
//      `no_managed_block`.
//   3. Write one commit on the branch whose parent is the head that was read.
//      The host refuses `head_moved` when someone pushed in between.
//   4. Run the six checks on that commit (checkCommittedHead), so the PR's
//      state and the "Oxagen steering" check describe the restored head.
//
// Every refusal comes before the commit.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { contextPrRestoreManagedBlock } from "@oxagen/oxagen/contracts/context.pr.restore_managed_block";
import type { ProposalStatus } from "@oxagen/oxagen/contracts/context.steering.shared";
import { checkCommittedHead } from "./context.pr.open";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  assertProductionBase,
  assertSameHost,
} from "./context.steering.github";
import {
  mergeClaimed,
  mergeInProgress,
  proposalMoved,
} from "./context.steering.store";
import { assertContractRole } from "./lib/capability-role-guard";
import { restoreManagedBlock } from "./steering-repo/managed-block";
import { readSteeringLayout } from "./steering-repo/merge-queue";

export interface RestoreManagedBlockDeps
  extends Pick<SteeringDeps, "store" | "github" | "now"> {
  /** The handler-side role check (lib/capability-role-guard.ts). */
  assertRole(ctx: Parameters<CapabilityHandler<typeof contextPrRestoreManagedBlock>>[1]): Promise<void>;
}

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

export function createRestoreManagedBlockHandler(
  deps: RestoreManagedBlockDeps,
): CapabilityHandler<typeof contextPrRestoreManagedBlock> {
  return async (input, ctx) => {
    await deps.assertRole(ctx);
    const actingUserId = await resolveActingUserId(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    if (row.status === "merged" || row.status === "rejected")
      throw proposalMoved(row.publicId, row.status);
    if (row.kind === "governance") {
      throw refuse(
        "governance_proposal",
        `${row.prUrl ?? row.publicId} changes the governance mode. Its branch holds no managed block to restore.`,
      );
    }
    if (row.status === "proposed" || row.prNumber === null || !row.branch || !row.path) {
      throw refuse(
        "pr_not_open",
        `${row.publicId} has no open steering PR, so there is no branch to restore ${input.path} on. Open its steering PR first.`,
      );
    }
    if (mergeClaimed(row, deps.now())) throw mergeInProgress(row.publicId, row.mergeClaimedAt);

    const repo = await deps.github.resolveRepository(scope);
    assertSameHost(repo, row.provider, row.prUrl);
    const pr = await deps.github.getPullRequest(repo, row.prNumber);
    assertProductionBase(repo, pr.baseRef, row.prUrl);
    if (!pr.open || pr.merged) {
      throw refuse(
        "pr_not_open",
        `${row.prUrl ?? row.publicId} is closed, so Oxagen cannot write to its branch.`,
      );
    }
    const layout = await readSteeringLayout(deps.github, repo);
    if (layout.layout !== "steering") {
      throw refuse(
        "no_managed_blocks",
        `${repo.fullName} keeps its steering under .oxagen/, which holds no managed blocks.`,
      );
    }
    const head = await deps.github.branchHead(repo, row.branch);
    if (head === null) {
      throw refuse(
        "head_unknown",
        `${row.branch} is gone from ${repo.fullName}, so there is no head to restore ${input.path} on.`,
      );
    }

    const [production, current] = await Promise.all([
      deps.github.readFile(repo, input.path, repo.defaultBranch),
      deps.github.readFile(repo, input.path, head),
    ]);
    const restored = restoreManagedBlock(production, current);
    if (restored.kind === "no_block") {
      throw refuse(
        "no_managed_block",
        `${input.path} on ${repo.defaultBranch} holds no managed block, so there is nothing to restore it from.`,
      );
    }
    if (restored.kind === "intact") {
      throw refuse(
        "block_intact",
        `The managed block in ${input.path} on ${row.branch} already matches ${repo.defaultBranch}, so there is nothing to restore.`,
      );
    }

    const { sha } = await deps.github.commitFiles(repo, {
      branch: row.branch,
      parent: head,
      message: `steering: restore the managed block in ${input.path}`,
      files: [{ path: input.path, content: restored.text }],
    });
    const checked = await checkCommittedHead(deps, {
      scope,
      repo,
      row,
      layout,
      path: row.path,
      branch: row.branch,
      to: sha,
      updatedById: actingUserId,
    });
    return { commit_sha: sha, status: checked.status as ProposalStatus };
  };
}

export const restoreManagedBlockHandler = createRestoreManagedBlockHandler({
  ...steeringDeps(),
  // The guard answers the role it found. The handler needs only the refusal.
  assertRole: async (ctx) => {
    await assertContractRole(contextPrRestoreManagedBlock, ctx);
  },
});
