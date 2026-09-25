// merge_context_pr (ADR-061; MC spec §10.3 steps 3-4). Refused until every
// check passed; refused unless the caller is a reviewer the governance mode
// allows (context.steering.policy.ts), read from governance.toml on the
// production branch at merge time; refused when the PR's head is no longer
// the commit the checks ran on, or when the PR no longer targets the
// production branch. The merge is pinned to that commit on GitHub
// and the published body is the file at that commit. A merge GitHub already
// holds (a retry after the publication failed) is resumed from its merge
// commit. The publication is stamped with the instant GitHub recorded, and a
// call that cannot read that instant is refused rather than stamping the
// record with its own clock. Only a merge GitHub confirmed publishes the
// record into the registry, appends the promotion event to the hash-chained
// ledger — the ledger length is the workspace's steering version — and emits
// `steering.published`; the head branch is deleted before the publication so
// the next proposal on the lineage branches from the production branch.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  assertProductionBase,
  assertSameHost,
  refuseMergedOnHost,
  type SteeringRepository,
} from "./context.steering.github";
import {
  GOVERNANCE_PATH,
  mergeRefusal,
  parseGovernanceMode,
} from "./context.steering.policy";
import { logger } from "./logger";
import { sha256Hex } from "./registry-digest";

export function createMergeContextPrHandler(
  deps: SteeringDeps,
): CapabilityHandler<typeof contextPrMerge> {
  return async (input, ctx) => {
    // The reviewer is a signed-in user; an API key carries none.
    const userId = ctx.userId ?? null;
    if (!userId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_principal",
        message: "Merging a Context PR needs a signed-in reviewer",
      });
    }
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
        reason: "already_merged",
        message: `${row.prUrl ?? row.publicId} is already merged`,
      });
    }
    if (row.status !== "checks_passed") {
      throw new HandlerError({
        code: "conflict",
        reason: "checks_not_passed",
        message: `Merge is blocked until every check passes (${row.status})`,
      });
    }
    if (
      row.prNumber === null ||
      !row.repository ||
      !row.branch ||
      !row.path ||
      !row.headSha ||
      !row.stampedRecordId ||
      !row.recordHash
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "pr_not_recorded",
        message: `Proposal ${row.publicId} has no recorded pull request`,
      });
    }

    const repo = await deps.github.resolveRepository(scope);
    assertSameHost(repo, row.provider, row.prUrl);
    const mode = parseGovernanceMode(
      await deps.github.readFile(repo, GOVERNANCE_PATH, repo.defaultBranch),
    );
    if (typeof mode !== "string") {
      throw new HandlerError({
        code: "conflict",
        reason: "governance_unreadable",
        message: mode.error,
      });
    }
    const refusal = mergeRefusal(
      mode,
      {
        userId,
        orgRole: await deps.roles.orgRole(ctx.orgId, userId),
        workspaceRole: await deps.roles.workspaceRole(
          ctx.orgId,
          ctx.workspaceId,
          userId,
        ),
      },
      row.createdById,
    );
    if (refusal) {
      throw new HandlerError({
        code: "forbidden",
        reason: refusal,
        message: `Governance mode ${mode} does not let this caller merge (${refusal})`,
      });
    }

    // The commit the checks ran on is the only one that merges.
    const pr = await deps.github.getPullRequest(repo, row.prNumber);
    if (pr.headSha !== row.headSha) {
      // Merged on the host after the head moved: running the checks again
      // cannot help, because a merged pull request's head never moves again.
      if (pr.merged) await refuseMergedOnHost(deps, scope, row, pr.headSha);
      throw new HandlerError({
        code: "conflict",
        reason: "head_moved",
        message: `${row.prUrl} moved to ${pr.headSha ?? "no commit"} after the checks ran on ${row.headSha}; run the checks again`,
      });
    }
    assertProductionBase(repo, pr.baseRef, row.prUrl);
    // The published body is the file at that commit.
    const body = await deps.github.readFile(repo, row.path, row.headSha);
    if (body === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "record_file_missing",
        message: `${row.path} is not at ${row.headSha}`,
      });
    }

    let commitSha: string;
    // The publication is stamped with the instant the commit landed on the
    // production branch, not this call's clock. They differ on a retry, and
    // the difference matters: `latestPublication` picks the newest
    // `published_at` as the commit a checkout must reach, and the retry
    // below can run after a later PR has published. Stamped with `now()`,
    // the earlier merge sorted newest, and a checkout at that earlier
    // commit read as current while it lacked the later record.
    //
    // The branch that performs the merge needs the same instant for the same
    // reason. Two Context PRs merging at once are two calls to GitHub, and
    // GitHub can land A before B while A's response comes back after B's; a
    // local clock then stamps A newer than the commit that descends from it,
    // and `latestPublication` names an ancestor as the tip a checkout must
    // reach. So the pull request is read again after the merge and stamped
    // with the instant GitHub recorded.
    let mergedAt: Date;
    if (pr.merged) {
      // GitHub merged it on an earlier call whose publication did not land.
      if (!pr.mergeCommitSha) {
        throw new HandlerError({
          code: "conflict",
          reason: "github_refused",
          message: `${row.prUrl} is merged with no merge commit`,
        });
      }
      commitSha = pr.mergeCommitSha;
      mergedAt = requireMergedAt(pr.mergedAt, row.prUrl);
    } else {
      commitSha = (
        await deps.github.mergePullRequest(repo, {
          number: row.prNumber,
          commitTitle: `steering: publish ${row.lineageId} (#${row.prNumber})`,
          sha: row.headSha,
        })
      ).sha;
      mergedAt = requireMergedAt(
        await mergedAtOnGitHub(deps, repo, row.prNumber),
        row.prUrl,
      );
    }
    await deps.github.deleteBranch(repo, row.branch);
    const result = await deps.store.publishMerge({
      scope,
      proposal: row,
      body,
      checksum: sha256Hex(body),
      commitSha,
      path: row.path,
      mergedAt,
      mergedByUserId: userId,
      policyVersion: `governance:${mode}`,
    });

    deps.emit({
      eventType: "steering.published",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: "merge_context_pr",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      {
        proposalId: row.publicId,
        lineageId: row.lineageId,
        pr: row.prUrl,
        commit: commitSha,
        bundleVersion: result.ledgerBefore + 1,
        workspaceId: ctx.workspaceId,
      },
      "context.pr.merge: published record",
    );

    return {
      proposalId: row.publicId,
      status: "merged",
      record: {
        id: result.recordPublicId,
        lineageId: row.lineageId,
        version: result.version,
        path: row.path,
      },
      mergedCommit: commitSha,
      promotionEvent: {
        id: result.promotion.publicId,
        seq: result.promotion.seq,
        chainDigest: result.promotion.chainDigest,
      },
      bundleVersion: {
        before: result.ledgerBefore,
        after: result.ledgerBefore + 1,
      },
    };
  };
}

/**
 * The instant GitHub recorded, or a refusal the caller can retry.
 *
 * A local clock is not a substitute here. Two Context PRs can merge at once,
 * and GitHub can land A before B while A's response comes back after B's:
 * stamped with this call's time, the earlier commit sorts newest,
 * `latestPublication` names it as the tip a checkout must reach, and a
 * checkout stopped at that ancestor reads as current while it lacks the later
 * record. That is the exact failure the GitHub instant exists to prevent, so
 * a guess is worse than no publication at all.
 *
 * Refusing does not lose the merge. It has landed on GitHub by the time this
 * runs, the proposal is still `checks_passed`, and the handler's resume path
 * reads the merge commit and its instant off the pull request and publishes
 * on the next call. That is the same path a publication that failed on the
 * store already takes. A `conflict` says so: nothing was published and the
 * merge is still there to publish.
 */
function requireMergedAt(mergedAt: Date | null, prUrl: string | null): Date {
  if (mergedAt) return mergedAt;
  throw new HandlerError({
    code: "conflict",
    reason: "merge_time_unknown",
    message: `${prUrl ?? "The pull request"} merged and GitHub has not said when, so nothing was published; merge again to publish it`,
  });
}

/**
 * The instant GitHub says the pull request merged. Null when GitHub reports
 * none, and null when the re-read itself fails.
 *
 * The merge already happened by the time this runs, so a failure here must
 * not throw out of the API client: the caller decides what an unknown instant
 * means, and it turns this null into a refusal the next call can resume from.
 */
async function mergedAtOnGitHub(
  deps: SteeringDeps,
  repo: SteeringRepository,
  prNumber: number,
): Promise<Date | null> {
  try {
    return (await deps.github.getPullRequest(repo, prNumber)).mergedAt;
  } catch (error) {
    logger.warn(
      { err: error, pr: prNumber },
      "context.pr.merge: could not re-read the merged pull request; the publication is refused and retried rather than stamped with this call's clock",
    );
    return null;
  }
}

export const mergeContextPrHandler = createMergeContextPrHandler(
  steeringDeps(),
);
