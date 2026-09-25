// context.steering.sync.ts: the repository sync (ADR-182). The record files on
// the main repository's production branch are the records in force; the
// registry mirrors them for listing, the ledger, and the policy bundle every
// wrapped agent receives. This makes the mirror match the branch, whatever
// changed it: a Context PR merged in Oxagen or on the host, a direct push, a
// renamed or deleted file.
//
// A push or a merge on the host starts it through the webhook, a scheduled
// sweep catches a delivery the webhook missed, and it is idempotent: the
// webhook is a trigger and the host's API is the truth, so a duplicate or
// out-of-order delivery reads the same branch and finds nothing left to do.
//
// Flow:
//   1. The workspace's main repository. No repository, no sync.
//   2. Every open Context PR, read from the host before the branch, so a merge
//      seen here is already on the head read next.
//   3. The production branch's head. Unchanged since the last sync with
//      nothing merged to settle: done.
//   4. Every file under `.oxagen/rules/` at that head, planned against the
//      registry and written in one transaction (context.steering.sync.store).
//   5. The Context PRs: a merged one points at its published record, a closed
//      one is rejected, and one whose head moved has its checks reset.
//   6. The sync state, and a check on the head commit naming every problem.
import { HandlerError } from "@oxagen/oxagen";
import {
  CHECK_NAMES,
  type CheckResult,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import type {
  SteeringHost,
  SteeringRepository,
} from "./context.steering.github";
import { createSteeringHost } from "./context.steering.host";
import {
  postgresSteeringStore,
  type ProposalRow,
  type SteeringStore,
} from "./context.steering.store";
import {
  planSync,
  RULES_DIR,
  type SyncFinding,
} from "./context.steering.sync.plan";
import {
  postgresSyncStore,
  type SyncState,
  type SyncStore,
} from "./context.steering.sync.store";
import { logger } from "./logger";

export interface SyncDeps {
  github: SteeringHost;
  store: SyncStore;
  steering: Pick<SteeringStore, "updateProposal">;
  now: () => Date;
}

export function syncDeps(): SyncDeps {
  return {
    github: createSteeringHost(),
    store: postgresSyncStore,
    steering: postgresSteeringStore,
    now: () => new Date(),
  };
}

export interface SyncOutcome {
  outcome: "no_repository" | "current" | "synced" | "problems";
  headSha: string | null;
  created: number;
  revised: number;
  updated: number;
  retired: number;
  proposals: { merged: number; rejected: number; stale: number };
  findings: SyncFinding[];
  /**
   * Seconds to wait before syncing again, or null. Set while a Context PR
   * Oxagen merged is still inside its grace window: `merge_context_pr`
   * publishes it with its reviewer on the ledger, and the sync leaves it alone
   * until the window passes.
   */
  retryAfterSeconds: number | null;
}

/** How long a merge Oxagen made is left to `merge_context_pr` to publish. */
export const MERGE_GRACE_SECONDS = 90;

/** The most record files one sync reads. Past it the sync refuses rather than cut. */
export const SYNC_MAX_FILES = 500;

/** How many file reads one sync keeps in flight. */
const READ_CONCURRENCY = 8;

/** The check the sync posts on the production branch's head. */
export const SYNC_CHECK_NAME = "Oxagen steering sync";

const STALE_FROM = [
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;
const OPEN_PR = ["pr_open", ...STALE_FROM] as const;

const pendingChecks = (): CheckResult[] =>
  CHECK_NAMES.map((name) => ({
    name,
    status: "pending",
    summary: "",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
  }));

type PullState = Awaited<ReturnType<SteeringHost["getPullRequest"]>>;

const hostName = (repo: SteeringRepository) =>
  repo.provider === "gitlab" ? "GitLab" : "GitHub";

async function readAll(
  github: SteeringHost,
  repo: SteeringRepository,
  ref: string,
  paths: string[],
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const batch = paths.slice(i, i + READ_CONCURRENCY);
    const texts = await Promise.all(
      batch.map((path) => github.readFile(repo, path, ref)),
    );
    batch.forEach((path, j) => {
      const text = texts[j];
      if (text !== null && text !== undefined) out.push({ path, text });
    });
  }
  return out;
}

/** A finding list as a check summary: one line per problem. */
function checkSummary(findings: SyncFinding[]): string {
  if (findings.length === 0)
    return "Every record file under `.oxagen/rules/` is in the registry.";
  return findings
    .map(
      (f) =>
        `- ${f.level === "error" ? "Not published" : "Warning"}: ${f.message}`,
    )
    .join("\n");
}

function sameFindings(a: SyncFinding[], b: SyncFinding[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Make the workspace's registry match its main repository's production
 * branch. `force` reads the branch even when its head has not moved.
 */
export async function syncWorkspaceSteering(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  options: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    outcome: "current",
    headSha: null,
    created: 0,
    revised: 0,
    updated: 0,
    retired: 0,
    proposals: { merged: 0, rejected: 0, stale: 0 },
    findings: [],
    retryAfterSeconds: null,
  };

  let repo: SteeringRepository;
  try {
    repo = await deps.github.resolveRepository(scope);
  } catch (err) {
    // No main repository is a workspace with nothing to sync, not a failure.
    if (err instanceof HandlerError && err.code === "not_found")
      return { ...outcome, outcome: "no_repository" };
    await recordFailure(deps, scope, null, err);
    throw err;
  }

  const prior = await deps.store.readState(scope);
  try {
    // 2. The open Context PRs, before the branch.
    const pulls: { row: ProposalRow; pr: PullState }[] = [];
    for (const row of await deps.store.openProposals(scope)) {
      if (row.prNumber === null || (row.provider ?? "github") !== repo.provider)
        continue;
      try {
        pulls.push({
          row,
          pr: await deps.github.getPullRequest(repo, row.prNumber),
        });
      } catch (err) {
        logger.warn(
          { err, proposal: row.publicId, pr: row.prNumber },
          "context.sync: could not read a Context PR; the next sync reads it again",
        );
      }
    }
    const now = deps.now();
    const defer = new Set<string>();
    const merged: { row: ProposalRow; pr: PullState }[] = [];
    for (const p of pulls) {
      if (!p.pr.merged || p.pr.baseRef !== repo.defaultBranch) continue;
      const inGrace =
        p.row.status === "checks_passed" &&
        p.pr.headSha === p.row.headSha &&
        p.pr.mergedAt !== null &&
        now.getTime() - p.pr.mergedAt.getTime() < MERGE_GRACE_SECONDS * 1000;
      if (inGrace) defer.add(p.row.lineageId);
      else merged.push(p);
    }

    // 3. The production branch's head.
    const head = await deps.github.branchHead(repo, repo.defaultBranch);
    if (head === null)
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_missing",
        message: `${repo.fullName} has no branch ${repo.defaultBranch}, the production branch its binding approved.`,
      });
    outcome.headSha = head;

    // 4. The record files at that head, planned and written.
    let findings = prior?.findings ?? [];
    const moved = prior?.headSha !== head || prior?.status === "failed";
    if (options.force || moved || merged.length > 0 || defer.size > 0) {
      const paths = await deps.github.listFiles(repo, head, RULES_DIR);
      if (paths.length > SYNC_MAX_FILES)
        throw new HandlerError({
          code: "conflict",
          reason: "steering_too_large",
          message: `${RULES_DIR}/ holds ${paths.length} files at ${head.slice(0, 7)}. The sync reads at most ${SYNC_MAX_FILES}.`,
        });
      const files = await readAll(deps.github, repo, head, paths);
      const last = await deps.github.lastCommitForPath(repo, RULES_DIR, head);
      const applied = await deps.store.apply(
        scope,
        {
          commitSha: last?.sha ?? head,
          publishedAt: last ? new Date(last.committedAt) : now,
          repository: repo.fullName,
          authoredBy: last?.authorLogin ?? last?.authorName ?? null,
          now,
        },
        (records) => planSync({ files, records, defer }),
      );
      findings = applied.plan.findings;
      Object.assign(outcome, {
        created: applied.created,
        revised: applied.revised,
        updated: applied.updated,
        retired: applied.retired,
      });
    }
    outcome.findings = findings;

    // 5. The Context PRs.
    for (const { row, pr } of pulls) {
      if (pr.merged && pr.baseRef !== repo.defaultBranch) {
        if (
          await reject(
            deps,
            row,
            `Merged on ${hostName(repo)} into ${pr.baseRef}, which is not the production branch ${repo.defaultBranch}`,
            now,
          )
        )
          outcome.proposals.rejected += 1;
      } else if (!pr.merged && !pr.open) {
        if (
          await reject(
            deps,
            row,
            `Closed on ${hostName(repo)} without merging`,
            now,
          )
        )
          outcome.proposals.rejected += 1;
      } else if (
        pr.open &&
        pr.headSha !== null &&
        row.headSha !== null &&
        pr.headSha !== row.headSha &&
        (STALE_FROM as readonly string[]).includes(row.status)
      ) {
        // The branch moved on the host after the checks ran. The checks no
        // longer describe what would merge, so they go back to pending and
        // the page asks for a new run.
        try {
          await deps.steering.updateProposal(
            row.id,
            { status: "pr_open", headSha: pr.headSha, checks: pendingChecks() },
            [row.status as (typeof STALE_FROM)[number]],
            { headSha: row.headSha },
          );
          outcome.proposals.stale += 1;
        } catch (err) {
          if (!(err instanceof HandlerError && err.code === "conflict"))
            throw err;
        }
      }
    }
    for (const { row, pr } of merged) {
      const linked = await deps.store.linkMergedProposal(scope, row.id, {
        lineageId: row.lineageId,
        mergedCommit: pr.mergeCommitSha ?? head,
        mergedAt: pr.mergedAt ?? now,
      });
      if (linked) {
        outcome.proposals.merged += 1;
        continue;
      }
      const why =
        findings.find(
          (f) =>
            f.level === "error" &&
            f.lineageId?.toLowerCase() === row.lineageId.toLowerCase(),
        )?.message ??
        `no record file on ${repo.defaultBranch} holds ${row.lineageId}`;
      if (
        await reject(
          deps,
          row,
          `Merged on ${hostName(repo)}, but Oxagen could not publish it: ${why}`,
          now,
        )
      )
        outcome.proposals.rejected += 1;
    }

    // 6. The state, and the check on the head.
    const changedFindings = !sameFindings(findings, prior?.findings ?? []);
    if (prior?.headSha !== head || changedFindings) {
      const errors = findings.filter((f) => f.level === "error").length;
      await deps.github
        .reportCheckRun(repo, {
          name: SYNC_CHECK_NAME,
          headSha: head,
          conclusion: errors > 0 ? "failure" : "success",
          title:
            findings.length === 0
              ? "The registry matches this commit"
              : `${findings.length} record file ${findings.length === 1 ? "problem" : "problems"}`,
          summary: checkSummary(findings),
          startedAt: now.toISOString(),
          completedAt: deps.now().toISOString(),
        })
        .catch((err: unknown) =>
          logger.warn(
            { err, head },
            "context.sync: could not post the sync check",
          ),
        );
    }
    await deps.store.writeState(scope, {
      provider: repo.provider,
      repository: repo.fullName,
      branch: repo.defaultBranch,
      headSha: head,
      status: findings.length > 0 ? "problems" : "synced",
      findings,
      error: null,
      syncedAt: deps.now(),
    });
    outcome.outcome =
      findings.length > 0
        ? "problems"
        : outcome.created +
              outcome.revised +
              outcome.updated +
              outcome.retired >
              0 ||
            outcome.proposals.merged +
              outcome.proposals.rejected +
              outcome.proposals.stale >
              0
          ? "synced"
          : "current";
    outcome.retryAfterSeconds = defer.size > 0 ? MERGE_GRACE_SECONDS : null;
    logger.info(
      {
        workspaceId: scope.workspaceId,
        head,
        outcome: outcome.outcome,
        created: outcome.created,
        revised: outcome.revised,
        updated: outcome.updated,
        retired: outcome.retired,
        proposals: outcome.proposals,
        findings: findings.length,
      },
      "context.sync: registry synced with the production branch",
    );
    return outcome;
  } catch (err) {
    await recordFailure(deps, scope, prior, err, repo);
    throw err;
  }
}

async function reject(
  deps: SyncDeps,
  row: ProposalRow,
  reason: string,
  at: Date,
): Promise<boolean> {
  try {
    await deps.steering.updateProposal(
      row.id,
      { status: "rejected", dismissedAt: at, dismissedReason: reason },
      OPEN_PR,
    );
    return true;
  } catch (err) {
    // Another call moved it first: a merge from Oxagen, or a dismissal.
    if (err instanceof HandlerError && err.code === "conflict") return false;
    throw err;
  }
}

/** Keep the last good head and findings, and say why this run failed. */
async function recordFailure(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  prior: SyncState | null,
  err: unknown,
  repo?: SteeringRepository,
): Promise<void> {
  try {
    await deps.store.writeState(scope, {
      provider: repo?.provider ?? prior?.provider ?? null,
      repository: repo?.fullName ?? prior?.repository ?? null,
      branch: repo?.defaultBranch ?? prior?.branch ?? null,
      headSha: prior?.headSha ?? null,
      status: "failed",
      findings: prior?.findings ?? [],
      error: err instanceof Error ? err.message : String(err),
      syncedAt: deps.now(),
    });
  } catch (writeErr) {
    logger.error(
      { err: writeErr, workspaceId: scope.workspaceId },
      "context.sync: could not record the failed sync",
    );
  }
}
