// The pull requests `get_run_work` lists (ADR-292), read from the forge
// store: each one's identity, state, head, base, files, and the issues it
// closes come from `forge.pull_requests`, its latest revision, and
// `forge.pull_request_issues`, and its per-file patches from the stored diff.
// Checks are the one live GitHub read, because the forge store holds none.
// They are read only for the pull requests the forge set names, at each one's
// stored head.
import { withTenantDb } from "@oxagen/database";
import { createGitHubClient, type GitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import { REVISION_DIFF_MAX_FILE_CHARS } from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import type {
  RunCheckout,
  RunRepository,
  RunWorkPr,
} from "@oxagen/oxagen/contracts/run.work.get";
import type { RunStore } from "@oxagen/run-ledger";
import type { RunScope } from "../run.list";
import { logger } from "../logger";
import { buildCiSummary } from "./ci-status";
import { type DiffStore, diffStore } from "./forge-pull-requests/diff-store";
import type { PullKey } from "./forge-pull-requests/read";
import {
  manifestFiles,
  readRevisionFiles,
  type RevisionFile,
} from "./forge-pull-requests/revision-files";
import {
  type BranchKey,
  branchKeyOf,
  type RunPullRequest,
  type RunPullRequestQuery,
  type RunPullRequestRead,
  readRunPullRequests,
} from "./forge-pull-requests/run-pulls";
import { type ConnectedRunRepository, workDigest } from "./run-work";

export interface RecordedRunPr {
  repositoryId: string;
  number: number;
  headSha: string | null;
  /** The ledger event that recorded it (`run_seq`), where the reader has one. */
  seq?: string;
}

/** The ledger events one page reads, and the pages one read walks. */
const LEDGER_EVENT_PAGE = 500;
const LEDGER_EVENT_PAGES = 20;

/**
 * The pull requests a ledger run recorded opening, from its
 * `provider_publish.pull_request_opened` events, walked 500 at a time for at
 * most 20 pages. `complete` is false when the walk stopped at that bound, so
 * a caller says the list may be short (`ledger_event_limit`). Shared by
 * `get_run_work` and `get_run_issues`, which read the same receipts.
 */
export async function readLedgerPrReceipts(
  store: Pick<RunStore, "readAttemptEventsSince">,
  runId: string,
): Promise<{ receipts: RecordedRunPr[]; complete: boolean }> {
  const receipts: RecordedRunPr[] = [];
  let cursor = "0";
  for (let page = 0; page < LEDGER_EVENT_PAGES; page++) {
    const events = await store.readAttemptEventsSince(
      runId,
      cursor,
      LEDGER_EVENT_PAGE,
    );
    for (const event of events) {
      if (
        event.eventType !== "provider_publish.pull_request_opened" ||
        typeof event.payload !== "object" ||
        event.payload === null
      )
        continue;
      const payload = event.payload as Record<string, unknown>;
      if (
        typeof payload.provider_repository_id !== "string" ||
        typeof payload.pull_request_number !== "number"
      )
        continue;
      receipts.push({
        repositoryId: payload.provider_repository_id,
        number: payload.pull_request_number,
        headSha:
          typeof payload.head_commit_sha === "string"
            ? payload.head_commit_sha
            : null,
        seq: event.runSeq,
      });
    }
    const last = events.at(-1);
    if (events.length < LEDGER_EVENT_PAGE || last === undefined)
      return { receipts, complete: true };
    cursor = last.runSeq;
  }
  return { receipts, complete: false };
}
/** The most pull requests one read lists. */
const PR_CAP = 20;
/** The most patch text one pull request carries, in UTF-16 code units. */
const DIFF_CHARS_CAP = 512 * 1024;
/**
 * The largest stored diff one pull request's patches are read from. A larger
 * one answers its file list with `diff_size_limit`, so a page read never
 * fetches megabytes it would then cut.
 */
const DIFF_FETCH_MAX_BYTES = 2 * 1024 * 1024;
/** The most stored diff bytes one read fetches across its pull requests. */
const DIFF_FETCH_TOTAL_BYTES = 8 * 1024 * 1024;

export interface WorkPrDeps {
  /** The forge rows behind the run's pull requests (ADR-292). */
  forge(
    scope: RunScope,
    query: RunPullRequestQuery,
  ): Promise<RunPullRequestRead>;
  /** The deployment's diff store; null when it names none. */
  store(): DiffStore | null;
  /** A GitHub client for one connected repository, for its checks alone. */
  client(
    scope: RunScope,
    repository: ConnectedRunRepository,
  ): Promise<Pick<GitHubClient, "listCiChecks">>;
}
export const defaultWorkPrDeps: WorkPrDeps = {
  forge: (scope, query) =>
    withTenantDb((tx) => readRunPullRequests(tx, scope, query)),
  store: diffStore,
  client: async (scope, repository) =>
    createGitHubClient({
      token: await resolveGitHubToken({
        ...scope,
        connectionId: repository.connectionId,
      }),
    }),
};

/** What names a run's pull requests, besides its own forge links. */
export interface WorkPrSources {
  /** The run's public id (`tse_` or `arun_`). */
  runId: string;
  checkouts: readonly RunCheckout[];
  /** A ledger run's `provider_publish` receipts. */
  receipts?: readonly RecordedRunPr[];
  /** The GitHub pull requests a wrapped run's link frames name. */
  links?: readonly { owner: string; name: string; number: number }[];
}

type PullRow = RunPullRequest["pull"];
type RevisionRow = NonNullable<RunPullRequest["revision"]>;

/** The forge for a recorded host, or null for a host Oxagen connects none on. */
function providerOf(host: string): BranchKey["provider"] | null {
  const lower = host.toLowerCase();
  if (lower === "github.com") return "github";
  if (lower === "gitlab.com") return "gitlab";
  return null;
}

/** The checkout's repository as a branch match names it, or null. */
function checkoutRepository(
  checkout: RunCheckout,
): { provider: BranchKey["provider"]; repository: string } | null {
  const repo = checkout.repository;
  if (repo === null) return null;
  const provider = providerOf(repo.host);
  return provider === null
    ? null
    : { provider, repository: `${repo.owner}/${repo.name}`.toLowerCase() };
}

/** The connected repository a forge row names, by its id first and its path second. */
function connectedOf(
  pull: PullRow,
  repositories: readonly ConnectedRunRepository[],
): ConnectedRunRepository | null {
  if (pull.provider !== "github") return null;
  return (
    repositories.find(
      (repo) => repo.providerRepositoryId === pull.providerRepositoryId,
    ) ??
    repositories.find(
      (repo) => `${repo.owner}/${repo.name}`.toLowerCase() === pull.repository,
    ) ??
    null
  );
}

/**
 * The repository a pull request is in. A connected one keeps the casing the
 * workspace links it with. Any other is read from the forge row, whose path
 * is lower-cased; a GitLab path may nest groups, so the name is its last part.
 */
function repositoryOf(
  pull: PullRow,
  connected: ConnectedRunRepository | null,
): RunRepository {
  if (connected !== null)
    return {
      host: connected.host,
      owner: connected.owner,
      name: connected.name,
      url: connected.url,
      connected: true,
    };
  const cut = pull.repository.lastIndexOf("/");
  return {
    host: pull.host,
    owner: pull.repository.slice(0, Math.max(cut, 0)),
    name: pull.repository.slice(cut + 1),
    url: `https://${pull.host}/${pull.repository}`,
    connected: false,
  };
}

/** True when the checkout was on the pull request's head branch or commit. */
function checkoutMatches(checkout: RunCheckout, pull: PullRow): boolean {
  const repo = checkoutRepository(checkout);
  if (
    repo === null ||
    repo.provider !== pull.provider ||
    repo.repository !== pull.repository
  )
    return false;
  return (
    (checkout.branch !== null &&
      checkout.branch !== "HEAD" &&
      checkout.branch === pull.headRef) ||
    (checkout.headSha !== null && checkout.headSha === pull.headSha)
  );
}

/**
 * The issues the pull request closes, from the forge store's issue links.
 * The sync reads them at each new head, so a pull request with no revision
 * yet was never read, and GitLab's closing references are not read at all.
 * Both answer null rather than "closes nothing".
 */
function closingIssuesOf(entry: RunPullRequest): RunWorkPr["closingIssues"] {
  if (entry.pull.provider !== "github" || entry.revision === null) return null;
  return {
    issues: entry.issues.map((issue) => {
      const cut = issue.repository.lastIndexOf("/");
      return {
        owner: issue.repository.slice(0, Math.max(cut, 0)),
        repo: issue.repository.slice(cut + 1),
        number: issue.number,
        title: issue.title ?? "",
        url: issue.url,
        state: issue.state === "closed" ? "closed" : "open",
      };
    }),
    complete: true,
  };
}

/** One file as the contract carries it. */
function fileOut(
  file: RevisionFile,
): NonNullable<RunWorkPr["diff"]>["files"][number] {
  return {
    path: file.path,
    previousPath: file.previousPath ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

/**
 * The pull request's diff from its revision. A stored revision's patches
 * come from the stored bytes, checked against their digest. A revision whose
 * bytes are not kept, or are over the fetch cap, answers its file list with
 * no patches, and its limitations say why.
 */
async function diffOf(
  pull: PullRow,
  revision: RevisionRow,
  store: DiffStore | null,
  fetch: boolean,
  warnings: Set<string>,
): Promise<NonNullable<RunWorkPr["diff"]>> {
  const limitations = [...revision.limitations];
  let files: RevisionFile[];
  if (revision.diffStatus !== "stored") {
    limitations.push(`diff_${revision.diffStatus}`);
    files = manifestFiles(revision);
  } else if (!fetch) {
    limitations.push("diff_size_limit");
    files = manifestFiles(revision);
  } else {
    const read = await readRevisionFiles(revision, store, {
      maxChars: DIFF_CHARS_CAP,
      maxFileChars: REVISION_DIFF_MAX_FILE_CHARS,
    });
    if (read.ok) {
      files = read.files;
      if (read.truncated || files.some((file) => file.truncated))
        limitations.push("diff_size_limit");
      if (files.some((file) => file.patch === null))
        limitations.push("patch_not_available");
    } else {
      warnings.add("diff_read_failed");
      limitations.push(read.reason);
      files = manifestFiles(revision);
    }
  }
  if (
    revision.filesChanged !== null &&
    revision.files.length < revision.filesChanged
  )
    limitations.push("diff_file_limit");
  const unique = [...new Set(limitations)];
  return {
    digest:
      revision.diffSha256 === null
        ? workDigest(
            JSON.stringify([pull.url, revision.headSha, files.map(fileOut)]),
          )
        : `sha256:${revision.diffSha256}`,
    headSha: revision.headSha,
    files: files.map(fileOut),
    complete: revision.complete && unique.length === 0,
    limitations: unique,
  };
}

/** The pull request's checks at its stored head, read live from GitHub. */
async function ciOf(
  scope: RunScope,
  pull: PullRow,
  connected: ConnectedRunRepository | null,
  deps: WorkPrDeps,
  warnings: Set<string>,
): Promise<{ ci: RunWorkPr["ci"]; headMatches: boolean }> {
  if (pull.provider !== "github") {
    warnings.add("gitlab_checks_not_read");
    return { ci: null, headMatches: true };
  }
  if (connected === null) {
    warnings.add("repository_not_connected");
    return { ci: null, headMatches: true };
  }
  try {
    const gh = await deps.client(scope, connected);
    const value = await gh.listCiChecks({
      owner: connected.owner,
      repo: connected.name,
      ref: pull.headSha,
    });
    const complete =
      value.complete ??
      (value.checkRuns.length < 100 && value.statuses.length < 100);
    if (!complete) warnings.add("ci_check_limit");
    const headMatches = value.sha === null || value.sha === pull.headSha;
    if (!headMatches) warnings.add("ci_head_mismatch");
    return { ci: { ...buildCiSummary(value), complete }, headMatches };
  } catch (error) {
    logger.warn(
      { err: error, orgId: scope.orgId, workspaceId: scope.workspaceId },
      "Run pull request checks could not be read",
    );
    warnings.add("ci_read_failed");
    return { ci: null, headMatches: true };
  }
}

/**
 * The run's pull requests: its forge change set, plus the pull requests the
 * forge store holds that a receipt, a link frame, or a checkout's branch
 * names. A pull request the run's links or receipts name is `recorded`; one
 * only a checkout's branch reaches is `head_commit` when the checkout was on
 * its head and `branch` otherwise. Nothing here asks a forge to find a pull
 * request.
 */
export async function readWorkPullRequests(
  scope: RunScope,
  sources: WorkPrSources,
  repositories: readonly ConnectedRunRepository[],
  deps: WorkPrDeps = defaultWorkPrDeps,
): Promise<{
  pullRequests: RunWorkPr[];
  complete: boolean;
  warnings: string[];
}> {
  const warnings = new Set<string>();
  const branches = new Map<string, BranchKey>();
  for (const checkout of sources.checkouts) {
    if (
      !repositories.some((repo) => repo.url === checkout.repository?.url)
    )
      warnings.add("repository_not_connected");
    const repo = checkoutRepository(checkout);
    if (repo === null) continue;
    if (checkout.branch === null) {
      warnings.add("branch_not_recorded");
      continue;
    }
    // A detached HEAD names no branch, so it names no work of its own.
    if (checkout.branch === "HEAD") {
      warnings.add("default_branch_not_linked");
      continue;
    }
    const key: BranchKey = { ...repo, branch: checkout.branch };
    branches.set(branchKeyOf(key), key);
  }
  const links: PullKey[] = (sources.links ?? []).map((link) => ({
    provider: "github",
    repository: `${link.owner}/${link.name}`.toLowerCase(),
    number: link.number,
  }));
  const read = await deps.forge(scope, {
    runId: sources.runId,
    receipts: (sources.receipts ?? []).map((receipt) => ({
      providerRepositoryId: receipt.repositoryId,
      number: receipt.number,
    })),
    links,
    branches: [...branches.values()],
  });
  if (read.unstored > 0) warnings.add("pull_request_not_stored");
  if (read.trunks.length > 0) warnings.add("default_branch_not_linked");
  if (read.pullRequests.length > PR_CAP) warnings.add("pull_request_limit");
  const listed = read.pullRequests.slice(0, PR_CAP);
  const store = deps.store();
  // The diff budget goes to the newest pull requests first.
  let fetchBudget = DIFF_FETCH_TOTAL_BYTES;
  const fetches = listed.map(({ revision }) => {
    const bytes = revision?.diffBytes ?? null;
    if (bytes === null || bytes > DIFF_FETCH_MAX_BYTES || bytes > fetchBudget)
      return false;
    fetchBudget -= bytes;
    return true;
  });
  const pullRequests = await Promise.all(
    listed.map(async (entry, index): Promise<RunWorkPr> => {
      const { pull, revision } = entry;
      const connected = connectedOf(pull, repositories);
      const checkouts = sources.checkouts.filter((checkout) =>
        checkoutMatches(checkout, pull),
      );
      const [checks, diff] = await Promise.all([
        ciOf(scope, pull, connected, deps, warnings),
        revision === null
          ? Promise.resolve(null)
          : diffOf(pull, revision, store, fetches[index] === true, warnings),
      ]);
      if (revision === null) warnings.add("pull_request_revision_missing");
      // The stored revision is for an earlier head while the latest one's
      // diff is not captured yet.
      const captured = revision !== null && revision.headSha === pull.headSha;
      if (revision !== null && !captured)
        warnings.add("pull_request_head_not_captured");
      return {
        repository: repositoryOf(pull, connected),
        number: pull.number,
        title: pull.title ?? "",
        url: pull.url,
        state:
          pull.state === "merged"
            ? "merged"
            : pull.state === "closed"
              ? "closed"
              : "open",
        headSha: pull.headSha,
        headRef: pull.headRef ?? "",
        baseRef: pull.baseRef ?? "",
        association:
          entry.sources.includes("run") || entry.sources.includes("recorded")
            ? "recorded"
            : checkouts.some((checkout) => checkout.headSha === pull.headSha)
              ? "head_commit"
              : "branch",
        closingIssues: closingIssuesOf(entry),
        checkoutIds: checkouts.map((checkout) => checkout.id),
        observedAt: pull.stateSeenAt.toISOString(),
        current: captured && checks.headMatches,
        ci: checks.ci,
        diff,
      };
    }),
  );
  return {
    pullRequests,
    complete: warnings.size === 0,
    warnings: [...warnings],
  };
}
