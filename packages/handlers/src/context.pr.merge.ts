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
// owner or holds merge_pr_without_review (ADR-213); the ledger and the
// trailers then say that nobody reviewed it. merge_pr_without_review runs
// this same handler under its own name
// (context.pr.merge_without_review.ts).
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
// promotion event to the hash-chained ledger, calls publish(), records the
// publish as a deployment to the steering environment, and emits
// `steering.published`. In a steering repo the Oxagen-Version trailer is the
// version publish() assigns next, read from its own version store. When
// publish() assigns another version, the merge is refused after it lands.
// A resumed merge whose commit S5 already published keeps that version and
// is not published again. In a legacy repository the version is the ledger
// length plus one.
// The head branch is deleted before the publication so the next proposal on
// the lineage branches from the production branch.
//
// One window stays open: a crash after the stamp merged and before the row
// moved to the stamp commit leaves the row at the checked head. The next call
// reads a merged PR at another head and refuses `merged_outside_oxagen`, which
// asks the repository sync to publish the merge from the production branch.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextPrMergeWithoutReview } from "@oxagen/oxagen/contracts/context.pr.merge_without_review";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import type { PublishResult, VersionStore } from "@oxagen/steering-bundle";
import { recheckContextPr } from "./context.pr.open";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { holdsCapability } from "./lib/capability-holder";
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
 * S5's publish() and the version store it assigns versions from. Both must
 * be bound to the same store: the merge reads the next version from `store`
 * and checks that publish() assigned that version.
 */
export interface SteeringPublisher {
  /** The key the store and publish() use for this repository. */
  repository: (repo: SteeringRepository) => string;
  /** The version store publish() assigns versions from. */
  store: Pick<VersionStore, "current" | "highestVersion">;
  /** S5's publish() at `commit`, bound to `store` and the repository. */
  publish: (repo: SteeringRepository, commit: string) => Promise<PublishResult>;
}

/**
 * The parts of a merge other lanes supply. Each has a default until its lane
 * lands: every repository reads healthy, nobody holds merge_pr_without_review,
 * the version is the ledger length plus one, and nothing is published.
 */
export interface MergeSeams {
  /** The steering repo's health (S2). */
  readHealth?: (scope: Scope, repo: SteeringRepository) => Promise<RepoHealth>;
  /** Whether the user holds merge_pr_without_review in the workspace. */
  holdsMergeWithoutReview?: (scope: Scope, userId: string) => Promise<boolean>;
  /**
   * The version a merge becomes when no publisher assigns it: in a legacy
   * repository, or in a steering repo before S5's publish() is wired.
   */
  nextVersion?: (scope: Scope) => Promise<number>;
  /**
   * Publish the steering repo at the merge commit (S5). Called in a steering
   * repo only: a legacy repository is the main code repository, which S5's
   * sync never publishes. A thrown error, a refusal, or a stale commit is
   * logged and the merge stands. A version other than the one in the
   * Oxagen-Version trailer refuses the call.
   */
  publisher?: SteeringPublisher;
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

/**
 * The merge handler. `capability` is the name the `steering.published`
 * event carries: merge_pr_without_review runs this handler under its own.
 */
export function createMergeContextPrHandler(
  deps: SteeringDeps,
  seams: MergeSeams = {},
  capability: string = contextPrMerge.name,
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
      // Only a steering repo publishes. Its trailer carries the version
      // publish() assigns, read from the store it assigns versions from.
      const publisher = layout.layout === "steering" ? seams.publisher : null;
      const mergedAs = pr.merged ? pr.mergeCommitSha : null;
      const steering = publisher
        ? await steeringVersion(publisher, repo, mergedAs)
        : null;
      const version = steering ? steering.version : await nextVersion(scope);

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
        const landed = await landSteeringPr({
          host: deps.github,
          repo,
          number: prNumber,
          branch,
          checkedHead: recorded.headSha,
          checks: passedChecks(row),
          layout,
          // Approvals count at the head the author pushed and at each merge
          // the queue makes on top of it. landSteeringPr reads them again
          // after each update.
          approve: (heads) =>
            mergeApproval({
              host: deps.github,
              repo,
              number: prNumber,
              mode,
              heads,
              authorUserId: recorded.createdById,
              merger,
              isMember: async (uid) => {
                const roles = await roleOf(uid);
                return (
                  roles.workspaceRole !== null ||
                  roles.orgRole === "Owner" ||
                  roles.orgRole === "Admin"
                );
              },
              holdsMergeWithoutReview: () =>
                holdsMergeWithoutReview(scope, userId),
            }),
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
      // S5 already published a resumed merge whose version it holds.
      if (publisher && !steering?.published) {
        await publishSteering(publisher, repo, commitSha, version);
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
        capability,
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
 * The version a steering merge becomes. A resumed merge whose commit S5
 * already published keeps that version, so the retry neither publishes again
 * nor refuses the version S5 assigned between the two calls. Any other merge
 * takes the version publish() assigns next: one past the highest in its
 * store.
 */
async function steeringVersion(
  publisher: SteeringPublisher,
  repo: SteeringRepository,
  mergedAs: string | null,
): Promise<{ version: number; published: boolean }> {
  const repository = publisher.repository(repo);
  if (mergedAs) {
    const current = await publisher.store.current(repository);
    if (current?.commit === mergedAs) {
      return { version: current.version, published: true };
    }
  }
  const highest = await publisher.store.highestVersion(repository);
  return { version: highest + 1, published: false };
}

/**
 * Call publish() after the registry holds the merge, and check that it
 * assigned the version in the Oxagen-Version trailer.
 *
 * The merge has landed and the row is merged, so nothing here can be retried
 * through this capability. A thrown error, a refusal, or a stale commit is
 * logged for the publish lane's own retry. A different version is refused
 * before the deployment and `steering.published` repeat the wrong number; a
 * retry then refuses `already_merged`, so the trailer is corrected by hand.
 */
async function publishSteering(
  publisher: SteeringPublisher,
  repo: SteeringRepository,
  commit: string,
  version: number,
): Promise<void> {
  let result: PublishResult;
  try {
    result = await publisher.publish(repo, commit);
  } catch (err) {
    logger.warn(
      { err, repository: repo.fullName, commit, version },
      "context.pr.merge: merged and recorded, but publish() failed",
    );
    return;
  }
  if (result.status === "refused" || result.status === "stale") {
    logger.warn(
      { repository: repo.fullName, commit, version, result },
      `context.pr.merge: merged and recorded, but publish() answered ${result.status}`,
    );
    return;
  }
  if (result.version !== version) {
    throw new HandlerError({
      code: "conflict",
      reason: "version_mismatch",
      message: `${repo.fullName} merged ${commit} with Oxagen-Version: ${version}, but publish() assigned version ${result.version}. The merge and its record stand. Correct the published version before the next merge.`,
    });
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

/**
 * The seams production binds. Whether a merger holds merge_pr_without_review
 * is the organization's IAM answer (ADR-213).
 */
export const productionMergeSeams: MergeSeams = {
  holdsMergeWithoutReview: (scope, userId) =>
    holdsCapability(contextPrMergeWithoutReview, scope, userId),
};

export const mergeContextPrHandler = createMergeContextPrHandler(
  steeringDeps(),
  productionMergeSeams,
);
