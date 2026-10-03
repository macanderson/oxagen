// evidence.ts: a send's pull request, head commit, and checks, read from
// GitHub and recorded as provider facts (P1-04, ADR-251).
//
// The review gate reads only facts (`reviewGate` in @oxagen/work/records), so
// everything Accept rests on is first written here, from GitHub's own answer:
//
//   - head_observed: the pull request's head commit. A new head voids an
//     earlier acceptance and every earlier check result (ADR-244).
//   - merged and pr_closed: a human merge, with its merge commit, or a close
//     without merging. Oxagen merges nothing.
//   - checks_required: the checks the base branch requires, from branch
//     protection and rulesets together. Recorded only when both reads
//     succeeded (`getRequiredStatusChecks` answers `ok: false` otherwise), so
//     a failed read leaves the head's required checks unread and Accept
//     blocked. An empty list opens Accept on ticks alone (roadmap#279), so it
//     must never come from a read that failed.
//   - check_observed: each check's latest conclusion on the head, matched to a
//     required check by name. GitHub's check runs carry no app id here, so a
//     required check that pins an app is matched by name only.
//
// Dedupe keys make a repeated read a repeat and a real change a new fact: a
// check's key names its conclusion and the provider's time for it, so a
// re-run that flips back to success is recorded again, and a required list
// is appended only when it differs from the one recorded for the head. A
// head's key names the pull request's update time, so a head that moves away
// and comes back to an earlier commit is recorded again, while a redelivery
// of the same event is a repeat. A head is recorded only when it differs from
// the head on record, and never after the merge, which fixes the head.
import { createHash } from "node:crypto";
import { schema, type Tx } from "@oxagen/database";
import { createGitHubClient, GitHubApiError, type GitHubCiChecks, type RequiredChecksRead } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import type { CheckConclusion, FactInput, FactKind, OrderProjection } from "@oxagen/work/records";
import { and, eq } from "drizzle-orm";
import { githubConnectionFor } from "../run-pull-request-backfill";
import type { WorkScope } from "./store";

/** A short digest of a list of check names, for a dedupe key. Pure. */
function namesDigest(names: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(names)).digest("hex").slice(0, 16);
}

/** A pull request as GitHub reports it now. */
export interface PullRequestRead {
  headSha: string | null;
  baseRef: string;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  updatedAt: string;
}

/** The three GitHub reads evidence takes. Tests pass fakes. */
export interface EvidenceReader {
  /** The pull request, or null when the workspace cannot read it. */
  readPullRequest(scope: WorkScope, repository: string, number: number): Promise<PullRequestRead | null>;
  readRequiredChecks(scope: WorkScope, repository: string, branch: string): Promise<RequiredChecksRead>;
  /** Every check on the commit, or null when the workspace cannot read them. */
  readChecks(scope: WorkScope, repository: string, sha: string): Promise<GitHubCiChecks | null>;
}

/** One check's conclusion on a commit, with GitHub's time for it. */
export interface ObservedCheck {
  name: string;
  conclusion: CheckConclusion;
  /** When GitHub finished or started it, or null when it gave no time. */
  at: string | null;
}

const RANK: Readonly<Record<CheckConclusion, number>> = {
  success: 0,
  neutral: 1,
  skipped: 2,
  stale: 3,
  pending: 4,
  action_required: 5,
  cancelled: 6,
  timed_out: 7,
  failure: 8,
};

/**
 * Each check's conclusion on the commit, one per name. Check runs and legacy
 * statuses are both read. Within one app, a re-run's latest result stands.
 * Between apps that report the same name, and between a check run and a
 * status, the less successful result wins, so a job named after a required
 * check cannot pass it for the app the branch requires. Pure.
 */
export function observedChecksOf(checks: GitHubCiChecks): ObservedCheck[] {
  const byName = new Map<string, ObservedCheck>();
  const time = (value: string | null) => (value === null ? 0 : Date.parse(value) || 0);
  const latestPerApp = new Map<string, ObservedCheck>();
  for (const run of checks.checkRuns) {
    const conclusion: CheckConclusion = run.status !== "completed" || run.conclusion === null ? "pending" : run.conclusion;
    const at = run.completedAt ?? run.startedAt;
    const key = JSON.stringify([run.name, run.appName ?? ""]);
    const prior = latestPerApp.get(key);
    if (prior === undefined || time(at) >= time(prior.at)) latestPerApp.set(key, { name: run.name, conclusion, at });
  }
  for (const check of latestPerApp.values()) {
    const prior = byName.get(check.name);
    if (prior === undefined || RANK[check.conclusion] > RANK[prior.conclusion]) byName.set(check.name, check);
  }
  for (const status of checks.statuses) {
    const conclusion: CheckConclusion = status.state === "error" ? "failure" : status.state;
    const at = status.updatedAt ?? status.createdAt;
    const prior = byName.get(status.context);
    if (prior === undefined || RANK[conclusion] > RANK[prior.conclusion]) byName.set(status.context, { name: status.context, conclusion, at });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What a read of one send's pull request found. */
export interface EvidenceRead {
  pull: PullRequestRead | null;
  required: RequiredChecksRead | null;
  checks: GitHubCiChecks | null;
}

/** What evidence found, beside the facts it records. */
export interface EvidenceSummary {
  head: string | null;
  /** The checks required on the head, or null when they could not be read. */
  requiredChecks: string[] | null;
  /**
   * Whether every check on the head was read now. False when the read failed
   * or GitHub's answer was cut short, so a result recorded earlier may be out
   * of date.
   */
  checksRead: boolean;
  /** Why the required checks or the check results could not be read, when they could not. */
  unreadReason: string | null;
}

function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  if (a === null || a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((name, index) => name === sorted[index]);
}

/**
 * The provider facts one read of a send's pull request adds, given what the
 * order already holds. Pure: the same read on the same order gives the same
 * facts, and facts the order holds come back with keys it already has.
 */
export function evidenceFacts(
  order: Pick<OrderProjection, "orderId" | "pullRequest" | "head" | "requiredChecks" | "merge">,
  read: EvidenceRead,
  now: string,
): { facts: FactInput<FactKind>[]; summary: EvidenceSummary } {
  const facts: FactInput<FactKind>[] = [];
  const pr = order.pullRequest;
  if (pr === null || read.pull === null) {
    return { facts, summary: { head: order.head, requiredChecks: null, checksRead: false, unreadReason: pr === null ? "no pull request" : "pull request unreadable" } };
  }
  const base = { source: "provider" as const, itemRevision: 1, orderId: order.orderId, actor: "github", repository: pr.repository, prNumber: pr.number };
  // Every key names the pull request: a send can move from one pull request
  // to another, and each one's head, merge, and close are its own.
  const prKey = `${order.orderId}:${pr.repository.toLowerCase()}#${pr.number}`;
  const head = read.pull.headSha;
  // A merged pull request keeps its merged head, so a later delivery that
  // names another head (a late one for an older commit) records nothing.
  if (head !== null && head !== order.head && order.merge === null) {
    facts.push({
      ...base,
      kind: "head_observed",
      headSha: head,
      occurredAt: read.pull.updatedAt,
      dedupeKey: `head_observed:${prKey}:${head}:${read.pull.updatedAt}`,
      data: {},
    });
  }
  if (read.pull.merged && read.pull.mergeCommitSha !== null && head !== null) {
    facts.push({
      ...base,
      kind: "merged",
      headSha: head,
      occurredAt: read.pull.mergedAt ?? read.pull.updatedAt,
      dedupeKey: `merged:${prKey}`,
      data: { merge_commit: read.pull.mergeCommitSha },
    });
  } else if (read.pull.state === "closed" && !read.pull.merged) {
    facts.push({ ...base, kind: "pr_closed", occurredAt: read.pull.updatedAt, dedupeKey: `pr_closed:${prKey}`, data: {} });
  }
  if (head === null) return { facts, summary: { head: null, requiredChecks: null, checksRead: false, unreadReason: "no head commit" } };

  let requiredChecks: string[] | null = null;
  let unreadReason: string | null = null;
  if (read.required === null) {
    unreadReason = "required checks not read";
  } else if (!read.required.ok) {
    unreadReason = read.required.reason;
  } else {
    requiredChecks = [...read.required.names].sort();
    const recorded = head === order.head ? order.requiredChecks : null;
    if (!sameList(recorded, requiredChecks)) {
      facts.push({
        ...base,
        kind: "checks_required",
        headSha: head,
        occurredAt: now,
        dedupeKey: `checks_required:${order.orderId}:${head}:${namesDigest(requiredChecks)}:${now}`,
        data: { names: requiredChecks },
      });
    }
  }
  const checksRead = read.checks !== null && read.checks.complete !== false;
  if (unreadReason === null && !checksRead) {
    unreadReason = read.checks === null ? "check results not read" : "GitHub returned only part of the check results";
  }
  if (read.checks !== null) {
    for (const check of observedChecksOf(read.checks)) {
      const at = check.at ?? now;
      facts.push({
        ...base,
        kind: "check_observed",
        headSha: head,
        occurredAt: at,
        dedupeKey: `check_observed:${order.orderId}:${head}:${check.name}:${check.conclusion}:${check.at ?? "untimed"}`,
        data: { name: check.name, conclusion: check.conclusion },
      });
    }
  }
  return { facts, summary: { head, requiredChecks, checksRead, unreadReason } };
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read one send's pull request evidence from GitHub. A read that throws (no
 * token, a network failure) counts as unread, never as an empty answer: the
 * pull request reads as unreadable, the required checks as `ok: false` with
 * the reason, and the checks as unknown. So a failed read blocks Accept with a
 * reason a person can act on. Pure apart from the reader.
 */
export async function readEvidence(
  reader: EvidenceReader,
  scope: WorkScope,
  order: Pick<OrderProjection, "pullRequest">,
): Promise<EvidenceRead> {
  const pr = order.pullRequest;
  if (pr === null) return { pull: null, required: null, checks: null };
  const pull = await reader.readPullRequest(scope, pr.repository, pr.number).catch(() => null);
  if (pull === null || pull.headSha === null) return { pull, required: null, checks: null };
  const [required, checks] = await Promise.all([
    reader
      .readRequiredChecks(scope, pr.repository, pull.baseRef)
      .catch((error: unknown): RequiredChecksRead => ({ ok: false, reason: `required checks read failed: ${failure(error)}` })),
    reader.readChecks(scope, pr.repository, pull.headSha).catch(() => null),
  ]);
  return { pull, required, checks };
}

function unreadable(error: unknown): boolean {
  return error instanceof GitHubApiError && (error.status === 403 || error.status === 404 || error.status === 410);
}

async function clientFor(scope: WorkScope, repository: string) {
  const [owner = "", repo = ""] = repository.split("/");
  const connectionId = await githubConnectionFor(scope, owner.toLowerCase());
  if (connectionId === null) return null;
  const client = createGitHubClient({ token: await resolveGitHubToken({ ...scope, connectionId }) });
  return { client, owner, repo };
}

/** The reader that asks GitHub through the workspace's own connection. */
export const githubEvidenceReader: EvidenceReader = {
  async readPullRequest(scope, repository, number) {
    const target = await clientFor(scope, repository);
    if (target === null) return null;
    try {
      const pr = await target.client.getPullRequest({ owner: target.owner, repo: target.repo, number });
      return {
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        state: pr.state,
        merged: pr.merged,
        mergeCommitSha: pr.mergeCommitSha,
        mergedAt: pr.mergedAt,
        updatedAt: pr.updatedAt,
      };
    } catch (error) {
      if (unreadable(error)) return null;
      throw error;
    }
  },
  async readRequiredChecks(scope, repository, branch) {
    const target = await clientFor(scope, repository);
    if (target === null) return { ok: false, reason: "no GitHub connection reads this repository" };
    return target.client.getRequiredStatusChecks({ owner: target.owner, repo: target.repo, branch });
  },
  async readChecks(scope, repository, sha) {
    const target = await clientFor(scope, repository);
    if (target === null) return null;
    try {
      return await target.client.listCiChecks({ owner: target.owner, repo: target.repo, ref: sha });
    } catch (error) {
      if (unreadable(error)) return null;
      throw error;
    }
  },
};

/**
 * The sends whose run linked this pull request, in the caller's scope. A
 * pr_linked fact stores the repository in lower case (runtime.ts), and the
 * index on it (item_facts_pr_linked_idx) finds them.
 */
export async function ordersForPullRequest(
  tx: Tx,
  scope: WorkScope,
  repository: string,
  number: number,
): Promise<{ itemId: string; orderId: string }[]> {
  const facts = schema.workItemFacts;
  const rows = await tx
    .selectDistinct({ itemId: facts.itemId, orderId: facts.orderId })
    .from(facts)
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        eq(facts.kind, "pr_linked"),
        eq(facts.repository, repository.toLowerCase()),
        eq(facts.prNumber, number),
      ),
    );
  return rows.filter((row): row is { itemId: string; orderId: string } => row.orderId !== null);
}
