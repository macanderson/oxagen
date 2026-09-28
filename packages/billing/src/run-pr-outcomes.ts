/**
 * run-pr-outcomes.ts: what each sealed run's pull requests became (#4491).
 *
 * The findings job prices spend that produced nothing: a pull request closed
 * without merging, one a later change reverted, or a run that opened none.
 * `cost.run_pr_outcomes` holds those outcomes, one row per run and pull
 * request, each value with the time Oxagen read it. This module is the pure
 * half: the row, the rules that fold a new read into it, and the parsers that
 * read a GitHub delivery and a revert. `run-pr-outcomes-store.ts` reads and
 * writes the table. The GitHub reads live in `packages/handlers`
 * (`lib/run-pr-outcomes-refresh.ts`), because this package has no GitHub
 * client.
 */

export type RunPrState = "open" | "closed" | "merged";
export type RunPrCiState = "passed" | "failed" | "pending" | "none";
export type RunPrProvider = "github" | "gitlab";
export type OutcomeRunSource = "ledger" | "tacho";
export type OutcomeScope = { orgId: string; workspaceId: string };

/** The `pr_key` of the one row a run with no pull request gets. */
export const NO_PR_KEY = "none";

/** How far back the refresh looks: the findings window, so every run a finding can cite has its outcome. */
export const OUTCOME_WINDOW_DAYS = 30;

/** Pull requests one refresh pass reads from GitHub per workspace. Each read is at most three API calls. */
export const OUTCOME_FORGE_READS_PER_PASS = 60;

/**
 * How long after a pull request closes the refresh still reads its head
 * branch. GitHub deletes a merged branch a few seconds after the merge when
 * the repository asks it to, so a read in the same minute can still find it.
 */
export const HEAD_BRANCH_SETTLE_MS = 60 * 60 * 1000;

/** The pull request's identity in the table: `github:owner/repo#N`, lower case. */
export function prKeyOf(
  provider: RunPrProvider,
  repository: string,
  number: number,
): string {
  return `${provider}:${repository.toLowerCase()}#${number}`;
}

/** One row of `cost.run_pr_outcomes`, as the code reads and writes it. */
export interface OutcomeRow {
  runId: string;
  runSource: OutcomeRunSource;
  /** `github:owner/repo#N`, or `none` for a run with no pull request. */
  prKey: string;
  provider: RunPrProvider | null;
  repository: string | null;
  number: number | null;
  url: string | null;
  prState: RunPrState | null;
  prStateReadAt: Date | null;
  /** When the refresh last asked GitHub for the pull request, whether or not GitHub answered. */
  forgeReadAttemptedAt: Date | null;
  closedAt: Date | null;
  merged: boolean;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  baseRef: string | null;
  headRef: string | null;
  headSha: string | null;
  headBranchExists: boolean | null;
  headBranchReadAt: Date | null;
  ciState: RunPrCiState | null;
  ciReadAt: Date | null;
  reverted: boolean;
  /** The change that reverted it: `github:owner/repo#N` or `github:owner/repo@sha`. */
  revertedBy: string | null;
  revertedAt: Date | null;
  revertedReadAt: Date | null;
  terminalReason: string | null;
  terminalReasonReadAt: Date | null;
  /** The forge's `updated_at` for the state held here. */
  sourceUpdatedAt: Date | null;
}

/** A pull request a run opened, before anything about it was read. */
export interface RunPr {
  provider: RunPrProvider;
  repository: string;
  number: number;
  url: string | null;
}

/** A row that holds nothing read yet: a pull request's, or the run's `none` row when `pr` is null. */
export function blankOutcome(
  runId: string,
  runSource: OutcomeRunSource,
  pr: RunPr | null,
): OutcomeRow {
  return {
    runId,
    runSource,
    prKey: pr ? prKeyOf(pr.provider, pr.repository, pr.number) : NO_PR_KEY,
    provider: pr?.provider ?? null,
    repository: pr ? pr.repository.toLowerCase() : null,
    number: pr?.number ?? null,
    url: pr?.url ?? null,
    prState: null,
    prStateReadAt: null,
    forgeReadAttemptedAt: null,
    closedAt: null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    baseRef: null,
    headRef: null,
    headSha: null,
    headBranchExists: null,
    headBranchReadAt: null,
    ciState: null,
    ciReadAt: null,
    reverted: false,
    revertedBy: null,
    revertedAt: null,
    revertedReadAt: null,
    terminalReason: null,
    terminalReasonReadAt: null,
    sourceUpdatedAt: null,
  };
}

/** A pull request's state as one read found it: the GitHub API, a delivery, or the stored run link. */
export interface PrStateRead {
  state: RunPrState;
  readAt: Date;
  /** When it closed or merged, when the read says. The GitHub API read does not. */
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  baseRef: string | null;
  headRef: string | null;
  headSha: string | null;
  /** The forge's `updated_at` for this state. */
  sourceUpdatedAt: Date | null;
}

/**
 * Whether a read is older than the state the row holds. Forges deliver out of
 * order, so the forge's `updated_at` decides when both carry one. A state the
 * forge dated outranks one it did not, whatever the read times. The read time
 * decides only between two undated states. The store's upsert holds the same
 * order (`saveOutcomeRows`).
 */
export function isStaleRead(row: OutcomeRow, read: PrStateRead): boolean {
  if (row.prState === null) return false;
  if (row.sourceUpdatedAt !== null)
    return (
      read.sourceUpdatedAt === null ||
      read.sourceUpdatedAt.getTime() < row.sourceUpdatedAt.getTime()
    );
  if (read.sourceUpdatedAt !== null) return false;
  return (
    row.prStateReadAt !== null &&
    read.readAt.getTime() < row.prStateReadAt.getTime()
  );
}

/**
 * The row with a state read folded in. A stale read changes nothing. A new
 * head commit clears the CI state, because the old commit's checks say
 * nothing about it. A closed pull request's close time comes from the read
 * when the read carries one. Otherwise it keeps the time already held, and a
 * first close takes the forge's `updated_at` as the nearest time Oxagen has.
 */
export function withStateRead(row: OutcomeRow, read: PrStateRead): OutcomeRow {
  if (isStaleRead(row, read)) return row;
  const merged = read.state === "merged";
  const wasClosed = row.prState === "closed" || row.prState === "merged";
  const closedAt =
    read.state === "open"
      ? null
      : ((merged ? read.mergedAt : null) ??
        read.closedAt ??
        (wasClosed ? row.closedAt : null) ??
        read.sourceUpdatedAt ??
        read.readAt);
  const headMoved =
    row.headSha !== null && read.headSha !== null && row.headSha !== read.headSha;
  return {
    ...row,
    prState: read.state,
    // Two sources can report one state: a later read of an older record keeps
    // the later read time, so the time never moves back.
    prStateReadAt:
      row.prStateReadAt !== null &&
      row.prStateReadAt.getTime() > read.readAt.getTime()
        ? row.prStateReadAt
        : read.readAt,
    closedAt,
    merged,
    mergedAt: merged ? (read.mergedAt ?? row.mergedAt ?? closedAt) : null,
    mergeCommitSha: merged ? (read.mergeCommitSha ?? row.mergeCommitSha) : null,
    baseRef: read.baseRef ?? row.baseRef,
    headRef: read.headRef ?? row.headRef,
    headSha: read.headSha ?? row.headSha,
    ciState: headMoved ? null : row.ciState,
    ciReadAt: headMoved ? null : row.ciReadAt,
    sourceUpdatedAt: read.sourceUpdatedAt ?? row.sourceUpdatedAt,
  };
}

/** A CI read of one head commit. */
export interface CiRead {
  state: RunPrCiState;
  headSha: string;
  readAt: Date;
}

/** The row with a CI read folded in, when the read is of the head commit the row holds. */
export function withCiRead(row: OutcomeRow, read: CiRead): OutcomeRow {
  if (row.headSha !== null && row.headSha !== read.headSha) return row;
  return { ...row, ciState: read.state, ciReadAt: read.readAt };
}

/** The row with a read of whether its head branch still exists. */
export function withHeadBranchRead(
  row: OutcomeRow,
  read: { exists: boolean; readAt: Date },
): OutcomeRow {
  return { ...row, headBranchExists: read.exists, headBranchReadAt: read.readAt };
}

/** A change that reverted a pull request, and when Oxagen saw it. */
export interface RevertMark {
  by: string;
  at: Date | null;
  readAt: Date;
}

/** The row marked reverted. The first revert Oxagen saw stays. */
export function withRevert(row: OutcomeRow, mark: RevertMark): OutcomeRow {
  if (row.reverted) return row;
  return {
    ...row,
    reverted: true,
    revertedBy: mark.by,
    revertedAt: mark.at,
    revertedReadAt: mark.readAt,
  };
}

/** The row with the run's terminal reason. */
export function withTerminalReason(
  row: OutcomeRow,
  reason: string | null,
  readAt: Date,
): OutcomeRow {
  return { ...row, terminalReason: reason, terminalReasonReadAt: readAt };
}

/**
 * Whether the hourly refresh reads a pull request from GitHub again. A row
 * is settled once its pull request is closed or merged, its CI finished, and
 * its head branch was read at least an hour after the close. Anything else,
 * including a row never written, is read again. A revert is not a reason:
 * the reverts kept in `cost.run_pr_reverts` mark those on every pass.
 */
export function needsForgeRead(row: OutcomeRow | undefined): boolean {
  if (!row) return true;
  if (row.prState === null || row.prState === "open") return true;
  if (row.ciState === null || row.ciState === "pending") return true;
  if (row.headBranchReadAt === null || row.closedAt === null) return true;
  return (
    row.headBranchReadAt.getTime() <
    row.closedAt.getTime() + HEAD_BRANCH_SETTLE_MS
  );
}

/** The CI verdict `buildCiSummary` answers (packages/handlers `lib/ci-status.ts`). */
export type CiOverallVerdict =
  | "passing"
  | "failing"
  | "pending"
  | "neutral"
  | "unknown";

/**
 * The row's CI state for a head commit's checks. `unknown` is a commit with
 * no checks. `neutral` is a commit whose every check finished skipped or
 * neutral. Nothing passed in either, so both read as `none`.
 */
export function ciStateOf(overall: CiOverallVerdict): RunPrCiState {
  switch (overall) {
    case "passing":
      return "passed";
    case "failing":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "none";
  }
}

/** A pull request named by repository and number. */
export type PrRef = { repository: string; number: number };

const REVERTS_RE =
  /\bReverts\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/gi;

/**
 * The pull requests a body says it reverts. GitHub's Revert button writes
 * `Reverts owner/repo#N` as the body of the pull request it opens. A bare
 * `Reverts #N` names a pull request in the body's own repository.
 */
export function revertTargetsOf(
  body: string | null | undefined,
  ownRepository: string,
): PrRef[] {
  if (!body) return [];
  const seen = new Map<string, PrRef>();
  for (const match of body.matchAll(REVERTS_RE)) {
    const repository = (match[1] ?? ownRepository).toLowerCase();
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    seen.set(`${repository}#${number}`, { repository, number });
  }
  return [...seen.values()];
}

const REVERT_COMMIT_RE = /\bThis reverts commit ([0-9a-f]{40})\b/gi;

/** The commits a commit message says it reverts, as `git revert` writes it. */
export function revertedShasOf(message: string | null | undefined): string[] {
  if (!message) return [];
  const shas = new Set<string>();
  for (const match of message.matchAll(REVERT_COMMIT_RE))
    shas.add(match[1]!.toLowerCase());
  return [...shas];
}

const COMMIT_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/commit\/[0-9a-f]{7,40}$/i;

/** `owner/repo` in lower case from a commit's `html_url`, or null. */
export function repositoryOfCommitUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const match = COMMIT_URL_RE.exec(url);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Why a wrapped run ended: the harness's terminal reason, else the reason
 * its root session closed, else its outcome once that is not `running`.
 */
export function tachoTerminalReason(session: {
  terminalReason: string | null;
  endReason: string | null;
  outcome: string | null;
}): string | null {
  if (session.terminalReason) return session.terminalReason;
  if (session.endReason) return session.endReason;
  if (session.outcome && session.outcome !== "running") return session.outcome;
  return null;
}

/** Why a ledger run ended: its latest seal's reason code, else the seal's terminal status. */
export function ledgerTerminalReason(
  seal: { reasonCode: string | null; terminalStatus: string } | null,
): string | null {
  if (!seal) return null;
  return seal.reasonCode || seal.terminalStatus;
}

/** A pull request delivery, reduced to what the table holds. */
export interface PullRequestDelivery extends PrStateRead {
  kind: "pull_request";
  repository: string;
  number: number;
  url: string | null;
  body: string | null;
}

/** One pushed commit, reduced to what a revert needs. */
export interface CommitDelivery {
  kind: "commit";
  repository: string;
  sha: string;
  /** The branch the push landed on, when the connector recorded it. */
  branch: string | null;
  message: string;
  at: Date | null;
  readAt: Date;
}

export type OutcomeDelivery = PullRequestDelivery | CommitDelivery;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function dateOf(value: unknown): Date | null {
  const text = stringOf(value);
  if (text === null) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The delivery an `ingestion/entity.received` event carries, or null when it
 * is neither a pull request nor a commit this table can use. The payload is
 * GitHub's own object: `pull_request` from a pull request delivery, or one
 * commit the GitHub connector reshaped from a push.
 */
export function outcomeDeliveryOf(
  sourceRecordType: string,
  payload: unknown,
  readAt: Date,
): OutcomeDelivery | null {
  const p = recordOf(payload);
  if (sourceRecordType === "pull_request") {
    const base = recordOf(p.base);
    const head = recordOf(p.head);
    const repository = stringOf(recordOf(base.repo).full_name)?.toLowerCase();
    const number = p.number;
    if (!repository || typeof number !== "number" || number <= 0) return null;
    const raw = stringOf(p.state);
    if (raw !== "open" && raw !== "closed") return null;
    const mergedAt = dateOf(p.merged_at);
    const merged = raw === "closed" && (p.merged === true || mergedAt !== null);
    const state: RunPrState =
      raw === "open" ? "open" : merged ? "merged" : "closed";
    return {
      kind: "pull_request",
      repository,
      number,
      url: stringOf(p.html_url),
      body: stringOf(p.body),
      state,
      readAt,
      closedAt: state === "open" ? null : (dateOf(p.closed_at) ?? mergedAt),
      mergedAt: merged ? mergedAt : null,
      // An open pull request's merge_commit_sha is GitHub's test merge, not a
      // commit on the base branch.
      mergeCommitSha: merged ? stringOf(p.merge_commit_sha) : null,
      baseRef: stringOf(base.ref),
      headRef: stringOf(head.ref),
      headSha: stringOf(head.sha),
      sourceUpdatedAt: dateOf(p.updated_at),
    };
  }
  if (sourceRecordType === "commit") {
    const sha = stringOf(p.sha)?.toLowerCase();
    const repository = repositoryOfCommitUrl(stringOf(p.html_url));
    const commit = recordOf(p.commit);
    const message = stringOf(commit.message);
    if (!sha || !repository || message === null) return null;
    return {
      kind: "commit",
      repository,
      sha,
      branch: stringOf(p.git_branch),
      message,
      at: dateOf(recordOf(commit.author).date),
      readAt,
    };
  }
  return null;
}

/** What one merged change reverts: pull requests by number, or merge commits by sha. */
export type RevertPlan =
  | { kind: "pull_requests"; targets: PrRef[]; mark: RevertMark }
  | {
      kind: "merge_commits";
      repository: string;
      shas: string[];
      /** The branch the reverting commit landed on; a target must merge into it. */
      branch: string | null;
      mark: RevertMark;
    };

/**
 * The reverts a delivery records, or null. A pull request reverts only once
 * it merges: an open revert that is closed unmerged reverted nothing.
 */
export function revertPlanOf(delivery: OutcomeDelivery): RevertPlan | null {
  if (delivery.kind === "pull_request") {
    if (delivery.state !== "merged") return null;
    const targets = revertTargetsOf(delivery.body, delivery.repository).filter(
      (t) =>
        !(t.repository === delivery.repository && t.number === delivery.number),
    );
    if (targets.length === 0) return null;
    return {
      kind: "pull_requests",
      targets,
      mark: {
        by: prKeyOf("github", delivery.repository, delivery.number),
        at: delivery.mergedAt ?? delivery.closedAt,
        readAt: delivery.readAt,
      },
    };
  }
  const shas = revertedShasOf(delivery.message);
  if (shas.length === 0) return null;
  return {
    kind: "merge_commits",
    repository: delivery.repository,
    shas,
    branch: delivery.branch,
    mark: {
      by: `github:${delivery.repository}@${delivery.sha}`,
      at: delivery.at,
      readAt: delivery.readAt,
    },
  };
}

/**
 * One revert of one target, as `cost.run_pr_reverts` keeps it. The target is
 * a pull request by number, or a merge commit by sha. The store keeps it
 * until the outcome row it reverts exists, since a revert can arrive before
 * the refresh writes that row.
 */
export interface RevertEvidence {
  repository: string;
  /** The reverted pull request, or null when the target is a merge commit. */
  number: number | null;
  /** The reverted merge commit, or null when the target is a pull request. */
  mergeCommitSha: string | null;
  /** The branch the reverting commit landed on. Null matches any branch. */
  branch: string | null;
  mark: RevertMark;
}

/** The evidence a revert plan records: one per target. */
export function revertEvidenceOf(plan: RevertPlan): RevertEvidence[] {
  if (plan.kind === "pull_requests")
    return plan.targets.map((t) => ({
      repository: t.repository.toLowerCase(),
      number: t.number,
      mergeCommitSha: null,
      branch: null,
      mark: plan.mark,
    }));
  return plan.shas.map((sha) => ({
    repository: plan.repository.toLowerCase(),
    number: null,
    mergeCommitSha: sha,
    branch: plan.branch,
    mark: plan.mark,
  }));
}

/**
 * Whether the evidence reverts the row's pull request. A pull request target
 * matches by repository and number. A merge commit target matches the row's
 * merge commit, on the branch the pull request merged into, as
 * `markMergeCommitsReverted` matches it.
 */
export function evidenceReverts(evidence: RevertEvidence, row: OutcomeRow): boolean {
  if (row.provider !== "github" || row.repository !== evidence.repository)
    return false;
  if (evidence.number !== null) return row.number === evidence.number;
  return (
    row.mergeCommitSha !== null &&
    row.mergeCommitSha === evidence.mergeCommitSha &&
    (evidence.branch === null || row.baseRef === evidence.branch)
  );
}

/**
 * The row marked with the earliest stored revert that names it. A row already
 * reverted keeps its revert, as `withRevert` does.
 */
export function withStoredReverts(
  row: OutcomeRow,
  evidence: readonly RevertEvidence[],
): OutcomeRow {
  if (row.reverted) return row;
  let first: RevertEvidence | null = null;
  for (const e of evidence)
    if (
      evidenceReverts(e, row) &&
      (first === null || e.mark.readAt.getTime() < first.mark.readAt.getTime())
    )
      first = e;
  return first === null ? row : withRevert(row, first.mark);
}
