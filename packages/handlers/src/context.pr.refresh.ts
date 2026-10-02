// audit-exempt: it records what the repository host already shows, as the repository sync does on every webhook and sweep; it publishes nothing, and the kernel capability.invoke_* audit records who asked.
//
// refresh_context_pr (ADR-184 decision 5): the repository sync's move for one
// Context PR, run now for the person on the Context PR page. GitHub (or
// GitLab) is the truth for a pull request's state, so the host is read first
// and the proposal follows it:
//
// - Closed on the host without merging: the proposal is closed with the
//   sync's reason and no person as its closer, and the branch is deleted.
// - Merged on the host: the repository sync publishes it, never this request
//   (ADR-184 decision 5: a publication inside a request could write an older
//   head over a newer one), so the refresh asks for a sync and says so.
// - Open with a head the checks did not run on: the checks reset to pending.
//
// Every write is the sync's compare-and-set: a proposal another call moved
// first, or a merge from Oxagen claimed, is left as it is and answered as it
// stands now. Calling it twice moves nothing the second time.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrRefresh } from "@oxagen/oxagen/contracts/context.pr.refresh";
import type { ProposalStatus } from "@oxagen/oxagen/contracts/context.steering.shared";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { assertSameHost } from "./context.steering.github";
import {
  closedOnHostReason,
  OPEN_PR,
  pendingChecks,
  STALE_FROM,
} from "./context.steering.pr-state";
import {
  claimCutoff,
  mergeClaimed,
  type ProposalRow,
} from "./context.steering.store";
import { logger } from "./logger";

/** The pull request as the host reports it. */
type HostState = {
  state: "open" | "merged" | "closed";
  headSha: string | null;
  baseRef: string;
};

const isOpen = (status: string): status is (typeof OPEN_PR)[number] =>
  (OPEN_PR as readonly string[]).includes(status);

const isStale = (status: string): status is (typeof STALE_FROM)[number] =>
  (STALE_FROM as readonly string[]).includes(status);

export function createRefreshContextPrHandler(
  deps: Pick<SteeringDeps, "store" | "github" | "now" | "requestSync">,
): CapabilityHandler<typeof contextPrRefresh> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
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
    const answer = (
      current: ProposalRow,
      host: HostState | null,
      extra: { changed?: boolean; syncRequested?: boolean } = {},
    ) => ({
      proposalId: current.publicId,
      status: current.status as ProposalStatus,
      host,
      changed: extra.changed ?? false,
      syncRequested: extra.syncRequested ?? false,
    });
    // Nothing is on the host before a pull request opens.
    if (row.prNumber === null) return answer(row, null);

    // A repository no longer installed, or a token the host refuses, throws
    // here with the host's own code, and nothing is written.
    const repo = await deps.github.resolveRepository(scope);
    assertSameHost(repo, row.provider, row.prUrl);
    const pr = await deps.github.getPullRequest(repo, row.prNumber);
    const host: HostState = {
      state: pr.merged ? "merged" : pr.open ? "open" : "closed",
      headSha: pr.headSha,
      baseRef: pr.baseRef,
    };

    // A merged or closed proposal is settled here: the host's answer comes
    // back for the page, and nothing moves.
    if (!isOpen(row.status)) return answer(row, host);
    // A merge from Oxagen is landing this PR. It moves the proposal itself.
    const now = deps.now();
    if (mergeClaimed(row, now)) return answer(row, host);
    const noClaimSince = claimCutoff(now);

    if (pr.merged) {
      // The sync publishes a merge on the host, or rejects one it cannot
      // publish, through the per-workspace queue.
      await deps.requestSync?.(scope);
      return answer(row, host, {
        syncRequested: deps.requestSync !== undefined,
      });
    }

    if (!pr.open) {
      try {
        const moved = await deps.store.updateProposal(
          row.id,
          {
            status: "rejected",
            dismissedAt: now,
            dismissedReason: closedOnHostReason(repo),
            // No person closed it: the page reads a null updater on a closed
            // proposal as a close on the host.
            updatedById: null,
          },
          OPEN_PR,
          { noClaimSince },
        );
        if (row.branch) {
          try {
            await deps.github.deleteBranch(repo, row.branch);
          } catch (err) {
            logger.warn(
              { err, proposal: row.publicId, branch: row.branch },
              "refresh_context_pr: could not delete a closed Context PR's branch",
            );
          }
        }
        return answer(moved, host, { changed: true });
      } catch (err) {
        if (!(err instanceof HandlerError && err.code === "conflict"))
          throw err;
        return answer(await current(deps, scope, row), host);
      }
    }

    if (
      pr.headSha !== null &&
      row.headSha !== null &&
      pr.headSha !== row.headSha &&
      isStale(row.status)
    ) {
      // The branch moved on the host after the checks ran, so they no longer
      // describe what would merge. A governance proposal runs the steering
      // checks, not the six record checks; setting the mode again runs them.
      try {
        const moved = await deps.store.updateProposal(
          row.id,
          {
            status: "pr_open",
            headSha: pr.headSha,
            checks: row.kind === "governance" ? [] : pendingChecks(),
          },
          [row.status],
          { headSha: row.headSha, noClaimSince },
        );
        return answer(moved, host, { changed: true });
      } catch (err) {
        if (!(err instanceof HandlerError && err.code === "conflict"))
          throw err;
        return answer(await current(deps, scope, row), host);
      }
    }
    return answer(row, host);
  };
}

/** The proposal as it stands after another call moved it first. */
async function current(
  deps: Pick<SteeringDeps, "store">,
  scope: { orgId: string; workspaceId: string },
  row: ProposalRow,
): Promise<ProposalRow> {
  return (await deps.store.findProposal(scope, row.publicId)) ?? row;
}

export const refreshContextPrHandler = createRefreshContextPrHandler(
  steeringDeps(),
);
