// The facts a forge reports about a pull request, mapped to one shape
// (ADR-288). A GitHub `pull_request` delivery, GitHub's REST answer, and
// GitLab's merge request answer each name the same things with different
// words. Every mapping here is pure, so the sync and its senders agree on
// what a pull request is without a read.
import type { GitHubPullRequest } from "@oxagen/github";
import type { GitLabMergeRequest } from "@oxagen/gitlab";
import type { ForgePullRequestFacts } from "@oxagen/inngest-functions/forge-pull-request-sync-runner";

export type ForgeProvider = "github" | "gitlab";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A commit id in lower case, or null when the value is not one. */
export function shaOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha = value.toLowerCase();
  return SHA.test(sha) ? sha : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** An ISO 8601 time, or null when the value is not one. */
function timeOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function positive(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

/**
 * The state a forge reports, in this table's words. GitHub says `closed` for
 * a merged pull request and reports the merge apart, so a merge wins. Only an
 * open pull request is a draft.
 */
function stateOf(
  merged: boolean,
  closed: boolean,
  draft: boolean,
): Pick<ForgePullRequestFacts, "state" | "draft"> {
  if (merged) return { state: "merged", draft: false };
  if (closed) return { state: "closed", draft: false };
  return { state: "open", draft };
}

/**
 * The pull request a GitHub `pull_request` delivery names, or null when the
 * payload lacks a field GitHub always sends. The base repository's id is the
 * key, so a delivery after a rename updates the same row. A merge commit is
 * kept only once the pull request merged: before that GitHub names a test
 * merge commit there, which no branch holds.
 */
export function githubDeliveryFacts(
  body: Record<string, unknown>,
): ForgePullRequestFacts | null {
  const pr = body.pull_request;
  if (typeof pr !== "object" || pr === null) return null;
  const p = pr as Record<string, unknown>;
  const base = (p.base ?? {}) as Record<string, unknown>;
  const head = (p.head ?? {}) as Record<string, unknown>;
  const baseRepo = (base.repo ?? {}) as Record<string, unknown>;
  const repository = (body.repository ?? {}) as Record<string, unknown>;
  const number = positive(p.number);
  const repoId = baseRepo.id ?? repository.id;
  const fullName = str(baseRepo.full_name) ?? str(repository.full_name);
  const headSha = shaOf(head.sha);
  const url = str(p.html_url);
  if (
    number === null ||
    (typeof repoId !== "number" && typeof repoId !== "string") ||
    fullName === null ||
    !fullName.includes("/") ||
    headSha === null ||
    url === null
  )
    return null;
  const merged = p.merged === true;
  const user = (p.user ?? {}) as Record<string, unknown>;
  return {
    host: "github.com",
    providerRepositoryId: String(repoId),
    repository: fullName.toLowerCase(),
    number,
    url,
    title: str(p.title),
    authorLogin: str(user.login),
    ...stateOf(merged, p.state === "closed", p.draft === true),
    baseRef: str(base.ref),
    headRef: str(head.ref),
    headSha,
    baseSha: shaOf(base.sha),
    mergeBaseSha: null,
    mergeCommitSha: merged ? shaOf(p.merge_commit_sha) : null,
    mergedAt: timeOf(p.merged_at),
    closedAt: timeOf(p.closed_at),
    sourceUpdatedAt: timeOf(p.updated_at),
  };
}

/**
 * GitHub's REST answer for a pull request as facts, or null when it names no
 * head commit or no base repository id, which an answer from a deleted fork
 * can lack.
 */
export function githubClientFacts(
  repository: string,
  pr: GitHubPullRequest,
): ForgePullRequestFacts | null {
  const headSha = shaOf(pr.headSha);
  const repoId = pr.baseRepositoryId;
  if (headSha === null || repoId === undefined || repoId === "") return null;
  const number = positive(pr.number);
  if (number === null) return null;
  return {
    host: "github.com",
    providerRepositoryId: repoId,
    repository: (pr.baseRepository ?? repository).toLowerCase(),
    number,
    url: pr.htmlUrl,
    title: str(pr.title),
    authorLogin: str(pr.authorLogin),
    ...stateOf(pr.merged, pr.state === "closed", pr.draft),
    baseRef: str(pr.baseRef),
    headRef: str(pr.headRef),
    headSha,
    baseSha: shaOf(pr.baseSha),
    mergeBaseSha: null,
    mergeCommitSha: pr.merged ? shaOf(pr.mergeCommitSha) : null,
    mergedAt: timeOf(pr.mergedAt),
    closedAt: timeOf(pr.closedAt),
    sourceUpdatedAt: timeOf(pr.updatedAt),
  };
}

/**
 * GitLab's answer for a merge request as facts, or null when it names no head
 * commit. `locked` is open: GitLab locks a merge request for a moment while it
 * merges, and the merge's own delivery follows. GitLab names the merge base
 * itself (`diff_refs.base_sha`), so the facts carry it.
 */
export function gitlabClientFacts(
  repository: string,
  mr: GitLabMergeRequest,
): ForgePullRequestFacts | null {
  const headSha = shaOf(mr.sha);
  const number = positive(mr.iid);
  if (headSha === null || number === null) return null;
  const merged = mr.state === "merged";
  return {
    host: "gitlab.com",
    providerRepositoryId: mr.projectId,
    repository: repository.toLowerCase(),
    number,
    url: mr.webUrl,
    title: str(mr.title),
    authorLogin: str(mr.authorLogin),
    ...stateOf(merged, mr.state === "closed", mr.draft === true),
    baseRef: str(mr.targetBranch),
    headRef: str(mr.sourceBranch),
    headSha,
    baseSha: shaOf(mr.targetSha),
    mergeBaseSha: shaOf(mr.baseSha),
    mergeCommitSha: merged
      ? (shaOf(mr.mergeCommitSha) ?? shaOf(mr.squashCommitSha))
      : null,
    mergedAt: timeOf(mr.mergedAt),
    closedAt: timeOf(mr.closedAt),
    sourceUpdatedAt: timeOf(mr.updatedAt),
  };
}

/**
 * The key that names a pull request within a workspace. The sync runs one
 * event per key at a time, so it must be the same whichever sender built it.
 */
export function pullKeyOf(
  workspaceId: string,
  provider: ForgeProvider,
  repository: string,
  number: number,
): string {
  return `${workspaceId}:${provider}:${repository.toLowerCase()}#${number}`;
}

/**
 * Where a head commit's diff is stored. The organization and workspace come
 * first, so one tenant's objects share a prefix no other tenant's do, and the
 * head commit comes last, so the key never names two different diffs.
 */
export function diffKeyOf(args: {
  orgId: string;
  workspaceId: string;
  provider: ForgeProvider;
  providerRepositoryId: string;
  number: number;
  headSha: string;
}): string {
  return [
    "pr-diffs",
    args.orgId,
    args.workspaceId,
    args.provider,
    encodeURIComponent(args.providerRepositoryId),
    String(args.number),
    `${args.headSha}.diff`,
  ].join("/");
}
