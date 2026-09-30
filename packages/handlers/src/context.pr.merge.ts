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
// version publish() assigns next, read from its own version store. The merge
// holds that store's lock from the read through publish(), across every
// process, so a repository sync cannot publish in between and take the
// number. A lock another publish holds for over a minute refuses
// `publish_in_progress` before anything is claimed or merged. When publish()
// still assigns another version, the merge's hold lapsed, and the merge is
// refused after it lands.
// A resumed merge whose commit S5 already published keeps that version and
// is not published again. A resumed merge whose commit S5 never published,
// on a production branch that has since moved past it, is refused
// `version_superseded` before the registry changes: publish() would answer
// stale, and the repository sync publishes the production branch instead.
// The deployment is recorded only for a version publish() made live. In a
// legacy repository the version is the ledger length plus one.
// The head branch is deleted before the publication so the next proposal on
// the lineage branches from the production branch.
//
// Before it lands the PR, the merge claims the proposal (merge_claimed_at).
// While the claim stands, a check rerun, a dismissal, and another merge are
// refused `merge_in_progress`, and the repository sync leaves the proposal
// alone. The stamp commit is the PR's head until the host merges it, so any
// of those would otherwise read a moved head and strand a proposal the host
// has merged (#4504). The publication clears the claim. A landing that fails
// before the host merged releases it. A landing that fails after the host
// merged keeps it, and a retry resumes the merge. A claim a crash left behind
// lapses after MERGE_CLAIM_SECONDS.
//
// A governance proposal (#4795, ADR-232) is the review-route PR
// set_governance_mode opens on steering/governance. It lands through the same
// queue, reviewer rule, claim, and approvals, with four differences. The
// check is governance/v1 on steering/governance.toml plus the steering
// checks, not the record checks. The merge publishes no record and appends no
// promotion event: the ledger line's Oxagen-Approved-By trailer, the row's
// merged_by_user_id, and `steering.governance_changed` name the approver. An
// approval is required, so neither a merger's ownership nor
// merge_pr_without_review lands one without review: Apply now is the recorded
// override. The output is the governance arm of the union on `kind`.
//
// One window stays open: a crash or a timeout after the stamp merged and
// before the row moved to the stamp commit leaves the row at the checked
// head. Once the claim lapses, the next call reads a merged PR at another
// head and refuses `merged_outside_oxagen`, which asks the repository sync to
// publish the merge from the production branch.
import {
  HandlerError,
  isHandlerError,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import {
  contextPrMerge,
  type ContextPrMergeOutput,
} from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextPrMergeWithoutReview } from "@oxagen/oxagen/contracts/context.pr.merge_without_review";
import type {
  GovernanceMode,
  RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import {
  governanceSchema,
  resolveGovernance,
} from "@oxagen/oxagen/steering-repo/governance";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import type { PublishResult } from "@oxagen/steering-bundle";
import { recheckContextPr } from "./context.pr.open";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { holdsCapability } from "./lib/capability-holder";
import {
  assertProductionBase,
  assertSameHost,
  refuseMergedOnHost,
  type SteeringHost,
  type SteeringRepository,
} from "./context.steering.github";
import { mergeRefusal } from "./context.steering.policy";
import {
  claimCutoff,
  mergeClaimed,
  mergeInProgress,
  type ProposalRow,
} from "./context.steering.store";
import { logger } from "./logger";
import { withToolProjection } from "./mcp-studio/publish-deps";
import { sha256Hex } from "./registry-digest";
import {
  landGovernancePr,
  passedCheckNames,
  productionSteeringGovernanceSeams,
  runGovernanceChecks,
  type GovernanceCheckContext,
  type SteeringGovernanceSeams,
} from "./steering-repo/governance-mode";
import {
  assertHealthy,
  inMergeQueue,
  landSteeringPr,
  mergeApproval,
  readSteeringLayout,
  recordPublishDeployment,
  type MergeApproval,
  type SteeringLayout,
} from "./steering-repo/merge-queue";
import { readSteeringHealth } from "./steering-repo/health.read";
import {
  type HeldPublish,
  type SteeringPublisher,
  steeringPublisher,
} from "./steering-repo/publisher";

export type { SteeringPublisher } from "./steering-repo/publisher";

type Scope = { orgId: string; workspaceId: string };

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
   * The publisher for the workspace's steering repo (S5), built per call from
   * the workspace and its host. Called in a steering repo only: a legacy
   * repository is the main code repository, which S5's sync never publishes.
   * The merge runs from its version read through publish() inside the
   * publisher's withLock. A thrown error, a refusal, or a stale commit is
   * logged, the merge stands, and no deployment is recorded. A version other
   * than the one in the Oxagen-Version trailer refuses the call.
   */
  publisher?: (scope: Scope, host: SteeringHost) => SteeringPublisher;
  /**
   * The steering checks a governance proposal runs on its head at merge
   * time and after each update (#4795). A governance merge refuses to start
   * without it.
   */
  governanceCheck?: SteeringGovernanceSeams["check"];
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
  // A governance proposal changes steering/governance.toml, which carries no
  // record stamp.
  const stamped =
    row.kind === "governance" || (!!row.stampedRecordId && !!row.recordHash);
  if (
    prNumber === null ||
    !repository ||
    !branch ||
    !path ||
    !headSha ||
    !stamped
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
      // Another call is landing this PR. Its stamp commit is the PR's head
      // until the host merges it, and the row moves to that commit only once
      // it has, so the head check below would misread either.
      if (
        mergeClaimed(recorded, deps.now()) &&
        (!pr.merged || pr.headSha !== recorded.headSha)
      ) {
        throw mergeInProgress(recorded.publicId, recorded.mergeClaimedAt);
      }
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
      // Approvals count at the head the author pushed and at each merge the
      // queue makes on top of it. landSteeringPr reads them again after each
      // update.
      const approve = (heads: readonly string[]) =>
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
          holdsMergeWithoutReview: () => holdsMergeWithoutReview(scope, userId),
        });
      if (recorded.kind === "governance") {
        return mergeGovernanceProposal({
          deps,
          seams,
          capability,
          scope,
          requestId: ctx.requestId ?? null,
          userId,
          repo,
          row: recorded,
          pr,
          layout,
          approve,
        });
      }
      // The published body is the file at the merged commit.
      let body = await readBody(deps, repo, path, recorded.headSha);
      // Only a steering repo publishes. Its trailer carries the version
      // publish() assigns, read from the store it assigns versions from.
      const publisher =
        layout.layout === "steering" && seams.publisher
          ? seams.publisher(scope, deps.github)
          : null;
      // The store's lock holds from the version read through publish(), so
      // no other publish can take the version the trailer names (#4550).
      const outcome = await underPublishLock(publisher, repo, async (held) => {
        const mergedAs = pr.merged ? pr.mergeCommitSha : null;
        const steering = publisher
          ? await steeringVersion(publisher, deps, scope, repo, row, mergedAs)
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
          // The host merged it on an earlier call whose publication did not
          // land.
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
          // Claim the proposal before the stamp moves the PR's head. The write
          // refuses a claim another call holds.
          row = await deps.store.updateProposal(
            row.id,
            { mergeClaimedAt: deps.now() },
            ["checks_passed"],
            {
              headSha: recorded.headSha,
              noClaimSince: claimCutoff(deps.now()),
            },
          );
          const landed = await landSteeringPr({
            host: deps.github,
            repo,
            number: prNumber,
            branch,
            checkedHead: recorded.headSha,
            checks: passedChecks(row),
            layout,
            approve,
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
          }).catch(async (err: unknown) => {
            await releaseUnmergedClaim(deps, repo, prNumber, row);
            throw err;
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
        // S5 already published a resumed merge whose version it holds. Any
        // other steering merge is live only once publish() says so, and a
        // deployment names only a version that went live.
        const live =
          !held ||
          steering?.published === true ||
          (await publishSteering(held, repo, commitSha, version));
        return { commitSha, attempts, version, result, live };
      });
      const { commitSha, attempts, version, result, live } = outcome;
      // The steering version this merge made live. A legacy repository has
      // no version store, so its merge publishes no steering version.
      const publishedVersion = publisher !== null && live ? version : null;
      const deploymentUrl = live
        ? await recordPublishDeployment(deps.github, repo, {
            sha: commitSha,
            version,
            number: prNumber,
          })
        : null;

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
          publishedVersion,
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
        kind: row.kind as RecordKind,
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
        publishedVersion,
      };
    });
  };
}

interface GovernanceMerge {
  deps: SteeringDeps;
  seams: MergeSeams;
  capability: string;
  scope: Scope;
  requestId: string | null;
  userId: string;
  repo: SteeringRepository;
  row: RecordedRow;
  pr: Awaited<ReturnType<SteeringHost["getPullRequest"]>>;
  layout: SteeringLayout;
  approve: (heads: readonly string[]) => Promise<MergeApproval>;
}

function governanceRefusal(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * The mode `steering/governance.toml` declares at `sha`, or a refusal. A file
 * that is not governance/v1 refuses `governance_invalid`, and nothing merges:
 * `[memory] auto_merge = true` outside solo is the case that exists today.
 */
async function governanceModeAt(
  deps: SteeringDeps,
  repo: SteeringRepository,
  row: Pick<ProposalRow, "prUrl">,
  path: string,
  sha: string,
): Promise<GovernanceMode> {
  const text = await deps.github.readFile(repo, path, sha);
  if (text === null) {
    throw governanceRefusal(
      "governance_file_missing",
      `${path} is not at ${sha} on ${row.prUrl ?? "the pull request"}. Set the mode again to open a new one.`,
    );
  }
  const read = readTomlFile(text, "governance/v1", governanceSchema);
  if (!read.ok) {
    const first = read.issues[0];
    throw governanceRefusal(
      "governance_invalid",
      `${path} at ${sha} is not governance/v1 (${first?.line ? `line ${first.line}: ` : ""}${first?.message ?? "it does not parse"}), so nothing merged. Set the mode again to open a new pull request.`,
    );
  }
  return resolveGovernance(read.value).mode;
}

/** An approval that stands without review refuses a governance merge. */
function reviewRequired(prUrl: string | null): HandlerError {
  return new HandlerError({
    code: "forbidden",
    reason: "review_required",
    message: `A governance change lands only after a workspace member other than its author approves ${prUrl ?? "its pull request"}. Apply now in the workspace's governance settings is the recorded override.`,
  });
}

/**
 * Land a governance proposal (#4795). The caller holds the merge queue and
 * has checked the health, the reviewer rule, the claim, the head, and the
 * base. This reads the mode the PR sets, runs the steering checks on the
 * head, claims the row, and lands the PR through landGovernancePr with an
 * approval that must be a review. A PR the host already merged on an earlier
 * call resumes from its merge commit. The row moves to `merged` with the
 * commit and the approver, and `steering.governance_changed` names both.
 */
async function mergeGovernanceProposal(
  input: GovernanceMerge,
): Promise<ContextPrMergeOutput> {
  const { deps, seams, scope, repo, pr, userId } = input;
  const recorded = input.row;
  const { prNumber, path } = recorded;
  let row: ProposalRow = recorded;
  // The reviewed route never records a merge without review (ADR-232).
  if (input.capability === contextPrMergeWithoutReview.name) {
    throw reviewRequired(recorded.prUrl);
  }
  const layout = input.layout;
  if (layout.layout !== "steering") {
    throw governanceRefusal(
      "layout_changed",
      `${repo.fullName} no longer holds ${path} on ${repo.defaultBranch}, so nothing merged. Set the mode again.`,
    );
  }
  const check = seams.governanceCheck;
  const publisherFor = seams.publisher;
  if (!check || !publisherFor) {
    throw new Error(
      "merge_context_pr: a governance merge needs the governanceCheck and publisher seams",
    );
  }
  // A merge the host already holds is read at its merge commit: the branch
  // is gone after the squash. Any other merge reads the head that merges.
  const setting = await governanceModeAt(
    deps,
    repo,
    recorded,
    path,
    pr.merged && pr.mergeCommitSha ? pr.mergeCommitSha : recorded.headSha,
  );
  // The mode in force when the PR opened. On a resume the production branch
  // already holds the new mode, so the layout cannot say what it replaced.
  const previousMode =
    (recorded.governanceMode as GovernanceMode | null) ?? null;
  let approvedBy: string[] = [];
  const approve = async (heads: readonly string[]) => {
    const approval = await input.approve(heads);
    if (approval.withoutReview) throw reviewRequired(recorded.prUrl);
    approvedBy = approval.approvedBy;
    return approval;
  };

  let commitSha: string;
  let mergedAt: Date;
  let publishedVersion: number | null = null;
  if (pr.merged) {
    // The host merged it on an earlier call whose record did not land. The
    // repository sync publishes the production branch that holds it.
    if (!pr.mergeCommitSha) {
      throw new HandlerError({
        code: "conflict",
        reason: "github_refused",
        message: `${recorded.prUrl} is merged with no merge commit`,
      });
    }
    commitSha = pr.mergeCommitSha;
    mergedAt = requireMergedAt(pr.mergedAt, recorded.prUrl);
    await deps.github.deleteBranch(repo, recorded.branch);
  } else {
    const checks: GovernanceCheckContext = {
      host: deps.github,
      repo,
      scope,
      now: deps.now,
      check,
    };
    // The row passed its checks when the PR opened, against the production
    // branch of that moment. They run again on the head that would merge.
    const main = await deps.github.branchHead(repo, repo.defaultBranch);
    const report =
      main === null
        ? null
        : await runGovernanceChecks(checks, recorded.headSha, main);
    if (!report?.passed) {
      await deps.store.updateProposal(
        recorded.id,
        { status: "checks_failed", updatedById: userId },
        ["checks_passed"],
        { headSha: recorded.headSha, noClaimSince: claimCutoff(deps.now()) },
      );
      throw governanceRefusal(
        "checks_failed",
        `The steering checks ${report === null ? "did not run" : "failed"} on ${recorded.headSha}, so nothing merged. ${recorded.prUrl} holds the report. Set the mode again to run them.`,
      );
    }
    // Claim the proposal before the stamp moves the PR's head.
    row = await deps.store.updateProposal(
      recorded.id,
      { mergeClaimedAt: deps.now() },
      ["checks_passed"],
      { headSha: recorded.headSha, noClaimSince: claimCutoff(deps.now()) },
    );
    const landed = await landGovernancePr({
      host: deps.github,
      repo,
      layout,
      number: prNumber,
      checkedHead: recorded.headSha,
      checks: passedCheckNames(report),
      mode: setting,
      approve,
      mergedBy: userId,
      publisher: publisherFor(scope, deps.github),
      now: deps.now,
      // The queue merged the production branch into the PR's branch. The row
      // follows the new head through checks_running, as a record's does.
      recheck: async (head) => {
        const from = row.headSha ?? recorded.headSha;
        row = await deps.store.updateProposal(
          row.id,
          { status: "checks_running", headSha: head, updatedById: userId },
          ["checks_passed"],
          { headSha: from },
        );
        const base = await deps.github.branchHead(repo, repo.defaultBranch);
        const again =
          base === null ? null : await runGovernanceChecks(checks, head, base);
        const ok = again?.passed === true;
        row = await deps.store.updateProposal(
          row.id,
          { status: ok ? "checks_passed" : "checks_failed" },
          ["checks_running"],
          { headSha: head },
        );
        return { ok, checks: ok && again ? passedCheckNames(again) : [] };
      },
    }).catch(async (err: unknown) => {
      await releaseUnmergedClaim(deps, repo, prNumber, row);
      throw err;
    });
    commitSha = landed.commitSha;
    if (landed.mergedHead !== row.headSha) {
      // The stamp commit merged: the row follows it, so a retry reads a
      // merged PR at the head the row names.
      row = await deps.store.updateProposal(
        row.id,
        { headSha: landed.mergedHead },
        ["checks_passed"],
        { headSha: row.headSha ?? recorded.headSha },
      );
    }
    mergedAt = requireMergedAt(
      await mergedAtOnGitHub(deps, repo, prNumber),
      recorded.prUrl,
    );
    publishedVersion = landed.live ? landed.version : null;
  }

  row = await deps.store.mergeGovernance({
    proposal: row,
    commitSha,
    mergedAt,
    mergedByUserId: userId,
  });
  const ledger = await deps.store.ledgerLength(scope);
  deps.emit({
    eventType: "steering.governance_changed",
    actorUserId: userId,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    capability: input.capability,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: input.requestId,
    detail: {
      fullName: repo.fullName,
      productionBranch: repo.defaultBranch,
      previousMode,
      mode: setting,
      commitSha,
      overrodeReview: false,
      approvedBy,
      proposalId: row.publicId,
      pullRequest: row.prUrl,
    },
  });
  logger.info(
    {
      proposalId: row.publicId,
      pr: row.prUrl,
      commit: commitSha,
      previousMode,
      mode: setting,
      approvedBy,
      publishedVersion,
      workspaceId: scope.workspaceId,
    },
    "context.pr.merge: merged governance mode",
  );
  return {
    proposalId: row.publicId,
    status: "merged",
    kind: "governance",
    governance: { mode: setting, path },
    mergedCommit: commitSha,
    bundleVersion: { before: ledger, after: ledger },
    publishedVersion,
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
 * nor refuses the version S5 assigned between the two calls. The lookup is by
 * commit, not by the published version, so a later merge published since
 * does not hide it. Any other merge takes the version publish() assigns next:
 * one past the highest in its store. The caller holds the store's lock until
 * publish() returns, so no other publish takes that number first.
 *
 * A resumed merge S5 never published is refused when the production branch
 * has moved past it. publish() would answer stale, so the version in its
 * trailer never goes live, and a later merge may already hold that number.
 * The refusal comes before the registry changes, and the repository sync
 * publishes the production branch, which holds this merge, instead.
 */
async function steeringVersion(
  publisher: SteeringPublisher,
  deps: SteeringDeps,
  scope: Scope,
  repo: SteeringRepository,
  row: Pick<ProposalRow, "id" | "publicId" | "prUrl" | "mergeClaimedAt">,
  mergedAs: string | null,
): Promise<{ version: number; published: boolean }> {
  const repository = publisher.repository(repo);
  if (mergedAs) {
    const stored = await publisher.store.versionAt(repository, mergedAs);
    if (stored?.published) {
      return { version: stored.version, published: true };
    }
    const head = await deps.github.branchHead(repo, repo.defaultBranch);
    if (head !== mergedAs) {
      // The sync links this merge, so an earlier call's claim must not hold
      // it off.
      if (row.mergeClaimedAt !== null) await releaseClaim(deps, row);
      await requestSync(deps, scope, row);
      throw new HandlerError({
        code: "conflict",
        reason: "version_superseded",
        message: `${row.prUrl ?? row.publicId} merged at ${mergedAs}, and ${repo.fullName}'s production branch ${repo.defaultBranch} has moved on to ${head ?? "no commit"} since. Oxagen is reading the production branch now, and this proposal shows what it published within a minute.`,
      });
    }
    if (stored) {
      // put() stored this commit and setPublished() did not switch to it.
      // publish() assigns the next number now, so the version that goes live
      // is one past the trailer on the merge commit.
      logger.warn(
        { repository, commit: mergedAs, stored: stored.version },
        "context.pr.merge: resuming a merge whose version was stored and never published; the version that goes live differs from its trailer",
      );
    }
  }
  const highest = await publisher.store.highestVersion(repository);
  return { version: highest + 1, published: false };
}

/** The statuses a claimed proposal can hold before it merges. */
const CLAIMABLE = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

/**
 * Clear a proposal's merge claim. A failure is logged and not thrown, so the
 * error that led here reaches the caller. The claim then lapses after
 * MERGE_CLAIM_SECONDS.
 */
async function releaseClaim(
  deps: SteeringDeps,
  row: Pick<ProposalRow, "id" | "publicId">,
): Promise<void> {
  try {
    await deps.store.updateProposal(row.id, { mergeClaimedAt: null }, [
      ...CLAIMABLE,
    ]);
  } catch (err) {
    logger.warn(
      { err, proposal: row.publicId },
      "context.pr.merge: could not release the merge claim; it lapses in ten minutes",
    );
  }
}

/**
 * After a landing failed, release the claim unless the host merged the PR.
 * A merged PR keeps the claim, so the sync leaves the proposal to a retry of
 * this merge until the claim lapses. A failed read keeps it too, and is
 * logged, so the landing's own error reaches the caller.
 */
async function releaseUnmergedClaim(
  deps: SteeringDeps,
  repo: SteeringRepository,
  prNumber: number,
  row: Pick<ProposalRow, "id" | "publicId">,
): Promise<void> {
  let merged: boolean;
  try {
    merged = (await deps.github.getPullRequest(repo, prNumber)).merged;
  } catch (err) {
    logger.warn(
      { err, proposal: row.publicId, pr: prNumber },
      "context.pr.merge: the landing failed and the pull request could not be read, so the merge claim stays; it lapses in ten minutes",
    );
    return;
  }
  if (merged) {
    logger.warn(
      { proposal: row.publicId, pr: prNumber },
      "context.pr.merge: the host merged the pull request, but the landing failed; the merge claim stays until a retry publishes it or the claim lapses in ten minutes",
    );
    return;
  }
  await releaseClaim(deps, row);
}

/** Ask for the repository sync, and log a request that fails. */
async function requestSync(
  deps: SteeringDeps,
  scope: Scope,
  row: { publicId: string },
): Promise<void> {
  try {
    await deps.requestSync?.(scope);
  } catch (err) {
    logger.warn(
      { err, proposal: row.publicId },
      "context.pr.merge: could not request a sync for a superseded merge; the scheduled sweep runs it",
    );
  }
}

/**
 * Run `work` under the publisher's lock, or without one when nothing
 * publishes. A lock another publish held for over a minute is refused before
 * `work` starts, so nothing was claimed or merged, and the refusal says to
 * merge again. An error `work` throws passes through unchanged.
 */
async function underPublishLock<T>(
  publisher: SteeringPublisher | null,
  repo: SteeringRepository,
  work: (held: HeldPublish | null) => Promise<T>,
): Promise<T> {
  if (!publisher) return work(null);
  let entered = false;
  try {
    return await publisher.withLock(repo, (held) => {
      entered = true;
      return work(held);
    });
  } catch (err) {
    if (
      !entered &&
      isHandlerError(err) &&
      err.reason === "publish_in_progress"
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "publish_in_progress",
        message: `Another publish of ${repo.fullName} is running, so nothing merged. Merge again in a minute.`,
      });
    }
    throw err;
  }
}

/**
 * Call publish() after the registry holds the merge, under the lock the merge
 * took before it read the version, and check that it assigned the version in
 * the Oxagen-Version trailer. True when that version is live: publish()
 * published it, or found the commit already published.
 *
 * The merge has landed and the row is merged, so nothing here can be retried
 * through this capability. A thrown error, a refusal, or a stale commit is
 * logged for the repository sync to publish the production branch, and
 * answers false so no deployment names a version that never went live. A
 * different version means the merge's hold on the lock lapsed and another
 * publish took the number. It is refused before the deployment and
 * `steering.published` repeat the wrong number. A retry then refuses
 * `already_merged`, so the trailer is corrected by hand.
 */
async function publishSteering(
  publish: HeldPublish,
  repo: SteeringRepository,
  commit: string,
  version: number,
): Promise<boolean> {
  let result: PublishResult;
  try {
    result = await publish(commit);
  } catch (err) {
    logger.warn(
      { err, repository: repo.fullName, commit, version },
      "context.pr.merge: merged and recorded, but publish() failed",
    );
    return false;
  }
  if (result.status === "refused" || result.status === "stale") {
    logger.warn(
      { repository: repo.fullName, commit, version, result },
      `context.pr.merge: merged and recorded, but publish() answered ${result.status}`,
    );
    return false;
  }
  if (result.version !== version) {
    throw new HandlerError({
      code: "conflict",
      reason: "version_mismatch",
      message: `${repo.fullName} merged ${commit} with Oxagen-Version: ${version}, but publish() assigned version ${result.version}. The merge and its record stand. Correct the published version before the next merge.`,
    });
  }
  return true;
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
  // A steering repo that is drifted, disconnected, or diverged merges
  // nothing until it is repaired (S2, #4560). The health is the last read
  // the settings webhooks and the 10-minute sweep stored.
  readHealth: (scope, repo) => readSteeringHealth(repo, scope),
  holdsMergeWithoutReview: (scope, userId) =>
    holdsCapability(contextPrMergeWithoutReview, scope, userId),
  // Each workspace publishes through its own version store and host, and
  // each version writes the workspace's tool registry (M13). The publish
  // refuses on the same health the merge reads.
  publisher: (scope, host) =>
    steeringPublisher({
      scope,
      host,
      extend: withToolProjection,
      readHealth: readSteeringHealth,
    }),
  // The checks set_governance_mode runs when it opens the PR (#4795).
  governanceCheck: productionSteeringGovernanceSeams.check,
};

export const mergeContextPrHandler = createMergeContextPrHandler(
  steeringDeps(),
  productionMergeSeams,
);
