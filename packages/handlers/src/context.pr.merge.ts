// merge_context_pr (ADR-061; MC spec §10.3 steps 3-4; steering-repo-spec,
// Steering PR flow). Oxagen is the only merger of a steering repo, and it
// merges one steering PR at a time per repository (steering-repo/merge-queue).
//
// Refused until every check passed; refused unless the caller is a reviewer
// the governance mode allows (context.steering.policy.ts), read from the
// production branch at merge time; refused while the repository is not
// healthy; refused when the PR's head is no longer the commit the checks ran
// on, or when the PR no longer targets the production branch. Outside solo
// mode the PR also needs an approval at that commit, unless the merger is an
// owner or holds merge_without_review; the ledger and the trailers then say
// that nobody reviewed it.
//
// At the head of the queue, a branch that no longer holds the production
// branch is brought up to date and checked again (recheckContextPr). In a
// steering repo Oxagen then pushes the stamp commit. The squash merge is
// pinned to that commit and ends with the Oxagen-Approved-By, Oxagen-Checks
// and Oxagen-Version trailers, and the published body is the file at that
// commit. A merge the host already holds (a retry after the publication
// failed) is resumed from its merge commit. The publication is stamped with
// the instant the host recorded, and a call that cannot read that instant is
// refused rather than stamping the record with its own clock. Only a merge
// the host confirmed publishes the record into the registry, appends the
// promotion event to the hash-chained ledger (the ledger length is the
// workspace's steering version), calls publish(), records the publish as a
// deployment to the steering environment, and emits `steering.published`.
// The head branch is deleted before the publication so the next proposal on
// the lineage branches from the production branch.
//
// One window stays open: a crash after the stamp merged and before the row
// moved to the stamp commit leaves the row at the checked head. The next call
// reads a merged PR at another head and refuses `merged_outside_oxagen`, which
// asks the repository sync to publish the merge from the production branch.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import { recheckContextPr } from "./context.pr.open";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  assertProductionBase,
  assertSameHost,
  refuseMergedOnHost,
  type SteeringRepository,
} from "./context.steering.github";
import { mergeRefusal } from "./context.steering.policy";
import type { ProposalRow } from "./context.steering.store";
import { logger } from "./logger";
import { sha256Hex } from "./registry-digest";
import {
  assertHealthy,
  inMergeQueue,
  landSteeringPr,
  mergeApproval,
  readSteeringLayout,
  recordPublishDeployment,
} from "./steering-repo/merge-queue";

type Scope = { orgId: string; workspaceId: string };

/**
 * The parts of a merge other lanes supply. Each has a default until its lane
 * lands: every repository reads healthy, nobody holds merge_without_review,
 * the version is the ledger length plus one, and publish() does nothing.
 */
export interface MergeSeams {
  /** The steering repo's health (S2). */
  readHealth?: (scope: Scope, repo: SteeringRepository) => Promise<RepoHealth>;
  /** Whether the user holds merge_without_review in the workspace. */
  holdsMergeWithoutReview?: (scope: Scope, userId: string) => Promise<boolean>;
  /** The published version this merge becomes. */
  nextVersion?: (scope: Scope) => Promise<number>;
  /**
   * Publish the steering repo at the merge commit (S5's publish(repo, sha)).
   * Called in a steering repo only: a legacy repository is the main code
   * repository, which S5's sync never publishes. A failure is logged, not
   * thrown.
   */
  publish?: (repo: SteeringRepository, commit: string) => Promise<void>;
}

/** A proposal row whose pull request is recorded, so it can merge. */
type RecordedRow = ProposalRow & {
  prNumber: number;
  repository: string;
  branch: string;
  path: string;
  headSha: string;
};

function mergeable(row: ProposalRow | null, proposalId: string): RecordedRow {
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "proposal_not_found",
      message: `No proposal ${proposalId} in this workspace`,
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
  const { prNumber, repository, branch, path, headSha } = row;
  if (
    prNumber === null ||
    !repository ||
    !branch ||
    !path ||
    !headSha ||
    !row.stampedRecordId ||
    !row.recordHash
  ) {
    throw new HandlerError({
      code: "conflict",
      reason: "pr_not_recorded",
      message: `Proposal ${row.publicId} has no recorded pull request`,
    });
  }
  return { ...row, prNumber, repository, branch, path, headSha };
}

const passedChecks = (row: ProposalRow): string[] =>
  row.checks.filter((c) => c.status === "passed").map((c) => c.name);

export function createMergeContextPrHandler(
  deps: SteeringDeps,
  seams: MergeSeams = {},
): CapabilityHandler<typeof contextPrMerge> {
  const readHealth =
    seams.readHealth ?? (async (): Promise<RepoHealth> => "healthy");
  const holdsMergeWithoutReview =
    seams.holdsMergeWithoutReview ?? (async () => false);
  const nextVersion =
    seams.nextVersion ??
    (async (scope: Scope) => (await deps.store.ledgerLength(scope)) + 1);

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
    const scope: Scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const queued = mergeable(
      await deps.store.findProposal(scope, input.proposalId),
      input.proposalId,
    );
    const repo = await deps.github.resolveRepository(scope);
    assertSameHost(repo, queued.provider, queued.prUrl);

    return inMergeQueue(repo, async () => {
      assertHealthy(await readHealth(scope, repo), repo);
      // The merge ahead of this one may have merged or moved this row.
      const recorded = mergeable(
        await deps.store.findProposal(scope, input.proposalId),
        input.proposalId,
      );
      const { prNumber, branch, path } = recorded;
      let row: ProposalRow = recorded;
      const layout = await readSteeringLayout(deps.github, repo);
      const mode = layout.mode;
      const roleOf = async (uid: string) => ({
        orgRole: await deps.roles.orgRole(ctx.orgId, uid),
        workspaceRole: await deps.roles.workspaceRole(
          ctx.orgId,
          ctx.workspaceId,
          uid,
        ),
      });
      const merger = { userId, ...(await roleOf(userId)) };
      const refusal = mergeRefusal(mode, merger, row.createdById);
      if (refusal) {
        throw new HandlerError({
          code: "forbidden",
          reason: refusal,
          message: `Governance mode ${mode} does not let this caller merge (${refusal})`,
        });
      }

      // The commit the checks ran on is the only one that merges.
      const pr = await deps.github.getPullRequest(repo, prNumber);
      if (pr.headSha !== recorded.headSha) {
        // Merged on the host after the head moved: running the checks again
        // cannot help, because a merged pull request's head never moves again.
        if (pr.merged) await refuseMergedOnHost(deps, scope, row, pr.headSha);
        throw new HandlerError({
          code: "conflict",
          reason: "head_moved",
          message: `${row.prUrl} moved to ${pr.headSha ?? "no commit"} after the checks ran on ${recorded.headSha}; run the checks again`,
        });
      }
      assertProductionBase(repo, pr.baseRef, row.prUrl);
      // The published body is the file at the merged commit.
      let body = await readBody(deps, repo, path, recorded.headSha);
      const version = await nextVersion(scope);

      let commitSha: string;
      let attempts = 0;
      // The publication is stamped with the instant the commit landed on the
      // production branch, not this call's clock. They differ on a retry, and
      // the difference matters: `latestPublication` picks the newest
      // `published_at` as the commit a checkout must reach, and the retry
      // below can run after a later PR has published. Stamped with `now()`,
      // the earlier merge sorted newest, and a checkout at that earlier
      // commit read as current while it lacked the later record.
      //
      // The branch that performs the merge needs the same instant for the
      // same reason. Two Context PRs merging at once are two calls to the
      // host, and it can land A before B while A's response comes back after
      // B's; a local clock then stamps A newer than the commit that descends
      // from it, and `latestPublication` names an ancestor as the tip a
      // checkout must reach. So the pull request is read again after the
      // merge and stamped with the instant the host recorded.
      let mergedAt: Date;
      if (pr.merged) {
        // The host merged it on an earlier call whose publication did not land.
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
        const approval = await mergeApproval({
          host: deps.github,
          repo,
          number: prNumber,
          mode,
          checkedHead: recorded.headSha,
          authorUserId: row.createdById,
          merger,
          isMember: async (uid) => {
            const roles = await roleOf(uid);
            return (
              roles.workspaceRole !== null ||
              roles.orgRole === "Owner" ||
              roles.orgRole === "Admin"
            );
          },
          holdsMergeWithoutReview: () => holdsMergeWithoutReview(scope, userId),
        });
        const landed = await landSteeringPr({
          host: deps.github,
          repo,
          number: prNumber,
          branch,
          checkedHead: recorded.headSha,
          checks: passedChecks(row),
          layout,
          approval,
          mergedBy: userId,
          commitTitle: `steering: publish ${row.lineageId} (#${prNumber})`,
          version,
          now: deps.now,
          recheck: async (head) => {
            row = await recheckContextPr(deps, {
              scope,
              repo,
              row,
              layout,
              path,
              branch,
              from: row.headSha ?? recorded.headSha,
              to: head,
              updatedById: userId,
            });
            return {
              ok: row.status === "checks_passed",
              checks: passedChecks(row),
            };
          },
        });
        commitSha = landed.commitSha;
        attempts = landed.attempts;
        if (landed.mergedHead !== row.headSha) {
          // The stamp commit merged: the row follows it, so the next call
          // reads a merged PR at the head the row names.
          row = await deps.store.updateProposal(
            row.id,
            { headSha: landed.mergedHead },
            ["checks_passed"],
            { headSha: landed.checkedHead },
          );
        }
        if (landed.mergedHead !== recorded.headSha) {
          // A re-check or a stamp moved the head: the registry holds the
          // bytes the production branch now holds.
          body = await readBody(deps, repo, path, landed.mergedHead);
        }
        mergedAt = requireMergedAt(
          await mergedAtOnGitHub(deps, repo, prNumber),
          row.prUrl,
        );
      }
      await deps.github.deleteBranch(repo, branch);
      const result = await deps.store.publishMerge({
        scope,
        proposal: row,
        body,
        checksum: sha256Hex(body),
        commitSha,
        path,
        mergedAt,
        mergedByUserId: userId,
        policyVersion: `governance:${mode}`,
      });
      if (layout.layout === "steering") {
        await publishQuietly(seams.publish, repo, commitSha, version);
      }
      const deploymentUrl = await recordPublishDeployment(deps.github, repo, {
        sha: commitSha,
        version,
        number: prNumber,
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
          version,
          attempts,
          layout: layout.layout,
          deploymentUrl,
          workspaceId: ctx.workspaceId,
        },
        "context.pr.merge: published record",
      );

      return {
        proposalId: row.publicId,
        status: "merged" as const,
        record: {
          id: result.recordPublicId,
          lineageId: row.lineageId,
          version: result.version,
          path,
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
    });
  };
}

/** The record file at `sha`, or a refusal naming it. */
async function readBody(
  deps: SteeringDeps,
  repo: SteeringRepository,
  path: string,
  sha: string,
): Promise<string> {
  const body = await deps.github.readFile(repo, path, sha);
  if (body === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "record_file_missing",
      message: `${path} is not at ${sha}`,
    });
  }
  return body;
}

/**
 * Call publish() after the registry holds the merge. The merge has landed and
 * the row is merged, so a failure here cannot be retried through this
 * capability: it is logged for the publish lane's own retry.
 */
async function publishQuietly(
  publish: MergeSeams["publish"],
  repo: SteeringRepository,
  commit: string,
  version: number,
): Promise<void> {
  if (!publish) return;
  try {
    await publish(repo, commit);
  } catch (err) {
    logger.warn(
      { err, repository: repo.fullName, commit, version },
      "context.pr.merge: merged and recorded, but publish() failed",
    );
  }
}

/**
 * The instant the host recorded, or a refusal the caller can retry.
 *
 * A local clock is not a substitute here. Two Context PRs can merge at once,
 * and the host can land A before B while A's response comes back after B's:
 * stamped with this call's time, the earlier commit sorts newest,
 * `latestPublication` names it as the tip a checkout must reach, and a
 * checkout stopped at that ancestor reads as current while it lacks the later
 * record. That is the exact failure the host's instant exists to prevent, so
 * a guess is worse than no publication at all.
 *
 * Refusing does not lose the merge. It has landed on the host by the time
 * this runs, the proposal is still `checks_passed`, and the handler's resume
 * path reads the merge commit and its instant off the pull request and
 * publishes on the next call. That is the same path a publication that failed
 * on the store already takes. A `conflict` says so: nothing was published and
 * the merge is still there to publish.
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
 * The instant the host says the pull request merged. Null when the host
 * reports none, and null when the re-read itself fails.
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
      "context.pr.merge: could not re-read the merged pull request; the publication is refused and retried rather than stamping it with this call's clock",
    );
    return null;
  }
}

export const mergeContextPrHandler = createMergeContextPrHandler(
  steeringDeps(),
);
