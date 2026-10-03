import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCheckRunArgs,
  GitHubCiChecks,
  GitHubClient,
  GitHubClientOptions,
  GitHubClosingIssues,
  GitHubCommitStatus,
  GitHubCompareDiff,
  GitHubCompareRefs,
  GitHubInstallationRepo,
  GitHubInstallationRepositories,
  GitHubIssueStates,
  GitHubMergedBy,
  GitHubPathCommit,
  GitHubPrComment,
  GitHubPrComments,
  GitHubPrFile,
  GitHubPullRequest,
  GitHubRelease,
  GitHubRepoInfo,
  RequiredChecksRead,
} from "./types";

/**
 * A non-2xx answer from the GitHub API. The status is a field, so callers
 * that treat one status specially (a 404 as "absent") branch on it rather
 * than on the message text, where an installation id or a rate-limit count
 * can contain the same digits.
 */
export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API error ${status}: ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

/** A refused request whose next permitted attempt exceeds this call's retry budget. */
export class GitHubRateLimitedError extends GitHubApiError {
  readonly code = "github_rate_limited" as const;
  constructor(
    status: number,
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(status, message);
    this.name = "GitHubRateLimitedError";
  }
}

function rateLimitDelay(
  res: Response,
  message: string,
  attempt: number,
): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers?.get("retry-after");
  const remaining = res.headers?.get("x-ratelimit-remaining");
  if (
    res.status !== 429 &&
    !retryAfter &&
    remaining !== "0" &&
    !/rate limit|secondary limit/i.test(message)
  )
    return null;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return delay;
  }
  const reset = Number(res.headers?.get("x-ratelimit-reset"));
  if (remaining === "0" && reset > 0)
    return Math.max(0, reset * 1000 - Date.now());
  return 60_000 * 2 ** attempt;
}

function isNotFound(err: unknown): boolean {
  return err instanceof GitHubApiError && err.status === 404;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes — internal use only
// ---------------------------------------------------------------------------

interface GHUser {
  login: string;
}

interface GHRepo {
  id: number;
  full_name: string;
  html_url: string;
  default_branch: string;
  owner: { login: string };
  name: string;
}

interface GHFileContent {
  sha: string;
}

interface GHPutFileResponse {
  commit: { sha: string };
  content: { html_url: string } | null;
}

interface GHRef {
  ref: string;
  object: { sha: string };
}

interface GHPull {
  number: number;
  html_url: string;
  body?: string | null;
}

interface GHErrorBody {
  message?: string;
}

interface GHCheckRun {
  id: number;
  html_url: string;
}

interface GHMerge {
  sha: string;
  merged: boolean;
}

interface GHContentsFile {
  type: string;
  encoding: string;
  content: string;
  sha: string;
  path: string;
}

interface GHBranchTreeRef {
  sha: string;
}

interface GHBranchCommitInner {
  tree: GHBranchTreeRef;
}

interface GHBranchCommit {
  sha: string;
  commit: GHBranchCommitInner;
}

interface GHBranch {
  commit: GHBranchCommit;
}

interface GHCommitListItem {
  sha: string;
  commit: {
    message?: string;
    author?: { name?: string; date?: string } | null;
  };
  author?: { login?: string } | null;
}

interface GHTreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GHTreeResponse {
  tree: GHTreeItem[];
  truncated: boolean;
}

interface GHActor {
  login: string;
  avatar_url?: string;
}

interface GHPullDetail {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  user: GHActor | null;
  created_at: string;
  updated_at: string;
  body: string | null;
  base: {
    ref: string;
    sha?: string | null;
    repo?: { id: number; full_name: string } | null;
  };
  head: {
    ref: string;
    sha: string | null;
    /** Null once a fork the pull request came from is deleted. */
    repo?: { full_name: string } | null;
  };
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  /** The account that merged it. GitHub sends null before the merge. */
  merged_by?: { login?: string; type?: string } | null;
  closed_at?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  comments?: number;
  review_comments?: number;
  labels?: GHLabel[];
}

interface GHLabel {
  name: string;
}

/**
 * The account that merged a pull request, or null when GitHub names none or
 * leaves out its login or its type. Pure.
 */
function mergedByOf(
  value: GHPullDetail["merged_by"],
): GitHubMergedBy | null {
  const login = value?.login;
  const type = value?.type;
  if (typeof login !== "string" || login === "") return null;
  if (typeof type !== "string" || type === "") return null;
  return { login, type };
}

interface GHIssueComment {
  id: number;
  user: GHActor | null;
  body: string | null;
  created_at: string;
  html_url: string | null;
}

interface GHReviewComment {
  id: number;
  user: GHActor | null;
  body: string | null;
  created_at: string;
  html_url: string | null;
  path: string | null;
}

interface GHCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  app: { name?: string } | null;
}

interface GHCheckRunsResponse {
  total_count: number;
  check_runs: GHCheckRun[];
}

interface GHStatusItem {
  context: string;
  state: string;
  target_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface GHCombinedStatus {
  sha: string | null;
  statuses: GHStatusItem[];
}

interface GHPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/**
 * One entry of `GET /installation/repositories`. It is a full repository
 * payload; only the fields a picker needs are declared.
 */
interface GHInstallationRepo extends GHRepo {
  private: boolean;
}

interface GHInstallationReposResponse {
  total_count: number;
  repositories: GHInstallationRepo[];
}

interface GHBranchListItem {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

/**
 * One source of required checks, read on its own. `present` is true when the
 * source has a required-checks setting for the branch.
 */
type RequiredChecksSourceRead =
  | { ok: true; names: string[]; present: boolean }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.github.com";

const CLOSING_ISSUES_QUERY = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 25) {
        totalCount
        nodes { number title url state repository { name owner { login } } }
      }
    }
  }
}`;

interface GHClosingIssuesResponse {
  data?: {
    repository?: {
      pullRequest?: {
        closingIssuesReferences?: {
          totalCount: number;
          nodes: {
            number: number;
            title: string;
            url: string;
            state: string;
            repository: { name: string; owner: { login: string } };
          }[];
        } | null;
      } | null;
    } | null;
  } | null;
  errors?: { message?: string }[];
}
/** The most issues one `getIssues` call reads. */
const ISSUES_PER_QUERY = 50;

interface GHIssueOrPullRequest {
  __typename: "Issue" | "PullRequest";
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
}

interface GHIssuesResponse {
  data?: {
    repository?: Record<string, GHIssueOrPullRequest | null> | null;
  } | null;
  errors?: { message?: string }[];
}

/** GitHub's `IssueStateReason`, lowercased; null for one this client does not know. */
function stateReasonOf(
  reason: string | null | undefined,
): GitHubIssueStates["issues"][number]["stateReason"] {
  switch (reason) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not_planned";
    case "REOPENED":
      return "reopened";
    case "DUPLICATE":
      return "duplicate";
    default:
      return null;
  }
}

interface GHRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

/** Page size for the installation-repositories walk — GitHub's maximum. */
const INSTALLATION_REPOS_PER_PAGE = 100;
/**
 * How many pages of `GET /installation/repositories` one call walks: 5 × 100
 * = 500 repositories. A bound, not a limit of the endpoint — an unbounded walk
 * turns one settings read into an arbitrary number of upstream requests, and a
 * person choosing a main repository out of more than 500 is better served by
 * narrowing the App's repository access than by a longer list.
 */
const MAX_PAGES = 5;
const DEFAULT_SLEEP_MS = 1500;

/** Page size for the branch-rules walk, GitHub's maximum. */
const BRANCH_RULES_PER_PAGE = 100;
/**
 * How many pages of `GET /rules/branches/{branch}` one read walks. A full
 * last page may hide more rules, and one of them could require a check, so
 * the read fails rather than answer with a list that may be short.
 */
const BRANCH_RULES_MAX_PAGES = 10;

/**
 * Percent-encode one URL path segment (an owner, a repo name, a PR number).
 * Every caller-supplied value that lands between two slashes goes through this:
 * without it a value containing `/`, `..`, `?` or `#` rewrites the request path
 * and the call hits an endpoint the caller never named.
 */
function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Percent-encode a repo-relative file path, segment by segment, so real
 * directory separators survive but nothing else can escape the path.
 *
 * `.` and `..` segments are rejected: the URL parser resolves them before the
 * request goes out, so `../../../user` on a `/repos/{o}/{r}/contents/` call
 * would silently retarget a different endpoint — or a different repository —
 * than the `owner`/`repo` arguments name.
 */
function filePath(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error(
        `Invalid repository file path "${path}": "." and ".." segments are not allowed.`,
      );
    }
  }
  return parts.map(encodeURIComponent).join("/");
}

/**
 * Create a GitHubClient backed by native fetch.
 *
 * @param opts - Client options (token, optional baseUrl, optional sleepMs/sleep).
 */
export function createGitHubClient(opts: GitHubClientOptions): GitHubClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const sleepMs = opts.sleepMs ?? DEFAULT_SLEEP_MS;

  // Caller cancellation also owns the time between requests. An injected sleep
  // may keep running, but it cannot keep this operation pending or start a retry.
  function sleep(ms: number): Promise<void> {
    const signal = opts.signal;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      function finish(error?: unknown, failed = false) {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (failed) reject(error);
        else resolve();
      }
      function onAbort() {
        finish(signal?.reason, true);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (opts.sleep) {
          opts.sleep(ms).then(
            () => finish(),
            (error: unknown) => finish(error, true),
          );
        } else {
          timer = setTimeout(() => finish(), ms);
        }
      } catch (error) {
        finish(error, true);
      }
    });
  }

  const commonHeaders: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // -------------------------------------------------------------------------
  // Internal request helper
  // -------------------------------------------------------------------------

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await send(method, path, body);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /**
   * One request with the rate-limit retries, answering the successful
   * response unread. `accept` asks for another media type, such as the raw
   * diff (`application/vnd.github.diff`).
   */
  async function send(
    method: string,
    path: string,
    body?: unknown,
    accept?: string,
  ): Promise<Response> {
    // A path is REST, under `baseUrl`; an absolute URL (GraphQL) is used as is.
    const url = path.startsWith("/") ? `${baseUrl}${path}` : path;
    const headers =
      accept === undefined ? commonHeaders : { ...commonHeaders, Accept: accept };
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, timeout])
        : timeout;
      const res = await fetch(url, {
        method,
        headers,
        signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) return res;
      let message = res.statusText;
      try {
        const err = (await res.json()) as GHErrorBody;
        if (err.message) message = err.message;
      } catch {
        // An aborted body read must not turn into another request.
        signal.throwIfAborted();
      }
      const delay = rateLimitDelay(res, message, attempt);
      if (delay === null) throw new GitHubApiError(res.status, message);
      if (attempt >= 2 || delay > (opts.maxRateLimitWaitMs ?? 120_000)) {
        throw new GitHubRateLimitedError(res.status, message, delay);
      }
      await sleep(delay);
    }
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async function getAuthenticatedUser(): Promise<{ login: string }> {
    const data = await request<GHUser>("GET", "/user");
    return { login: data.login };
  }

  async function getRepoInfo(args: {
    owner: string;
    repo: string;
  }): Promise<GitHubRepoInfo> {
    const data = await request<GHRepo>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}`,
    );
    return {
      // GitHub's numeric repository id survives renames and transfers; it is
      // what a repository binding pins (ingestion.repository_bindings).
      id: String(data.id),
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch,
    };
  }

  async function createRepoInOrg(args: {
    org?: string;
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }> {
    const body: Record<string, unknown> = { name: args.name };
    if (args.description !== undefined) body.description = args.description;
    if (args.private !== undefined) body.private = args.private;
    if (args.autoInit !== undefined) body.auto_init = args.autoInit;

    // With an org → create inside that organisation. Without one → create in
    // the authenticated user's personal account. `POST /orgs/{user}/repos`
    // 404s for a personal account (a user is not an org), so personal repos
    // MUST go through `/user/repos`.
    const path = args.org ? `/orgs/${seg(args.org)}/repos` : "/user/repos";
    const data = await request<GHRepo>("POST", path, body);
    return {
      fullName: data.full_name,
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch,
    };
  }

  async function putFile(args: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
  }): Promise<{ commitSha: string; htmlUrl: string }> {
    // Check whether the file already exists so we can supply its sha for an
    // update (GitHub requires it; omitting it on an existing file = 422).
    let existingSha: string | undefined;
    const contentsPath = `/repos/${seg(args.owner)}/${seg(args.repo)}/contents/${filePath(args.path)}`;
    const refQuery = args.branch
      ? `?ref=${encodeURIComponent(args.branch)}`
      : "";
    try {
      const existing = await request<GHFileContent>(
        "GET",
        `${contentsPath}${refQuery}`,
      );
      existingSha = existing.sha;
    } catch (err) {
      // Only a 404 means "create". A 401, 403 or 500 here would otherwise be
      // read as "absent", and the PUT without a sha would then fail with an
      // unrelated 422 (or overwrite nothing) while the real cause is hidden.
      if (!isNotFound(err)) throw err;
    }

    const base64Content = Buffer.from(args.content, "utf8").toString("base64");
    const putBody: Record<string, unknown> = {
      message: args.message,
      content: base64Content,
    };
    if (args.branch !== undefined) putBody.branch = args.branch;
    if (existingSha !== undefined) putBody.sha = existingSha;

    const data = await request<GHPutFileResponse>("PUT", contentsPath, putBody);

    return {
      commitSha: data.commit.sha,
      htmlUrl: data.content?.html_url ?? "",
    };
  }

  async function forkRepo(args: {
    owner: string;
    repo: string;
    org?: string;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }> {
    const forkBody: Record<string, unknown> = {};
    if (args.org) forkBody.organization = args.org;

    // GitHub returns fork metadata immediately, but the fork may not be
    // reachable yet — poll until it resolves.
    const forkData = await request<GHRepo>(
      "POST",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/forks`,
      forkBody,
    );

    // Derive fork coordinates from full_name returned by the API.
    const [forkOwner, forkRepoName] = forkData.full_name.split("/") as [
      string,
      string,
    ];

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const data = await request<GHRepo>(
          "GET",
          `/repos/${seg(forkOwner)}/${seg(forkRepoName)}`,
        );
        // An abort that lands while the response body is still being read
        // never reaches the catch below, so a cancelled operation would
        // answer with a fork the caller already stopped waiting for. The
        // catch re-throws this same reason, so either path reports the
        // cancellation identically.
        opts.signal?.throwIfAborted();
        return {
          fullName: data.full_name,
          htmlUrl: data.html_url,
          defaultBranch: data.default_branch,
        };
      } catch (error) {
        // Availability polling must not restart the request's retry budget or
        // turn a cancelled/timed-out operation into a successful fork result.
        // Cancellation is asked first so an abort that raced a stale 404 is
        // reported as the cancellation it is.
        opts.signal?.throwIfAborted();
        // Only a 404 means "the fork is not reachable yet". A 401, a
        // non-rate-limit 403, a 5xx or a transport fault says nothing about
        // whether the fork exists, and swallowing it here would retry until
        // the budget ran out and then return the creation response as a
        // success — the same silent wrong answer this poll exists to avoid.
        // `putFile` above draws the line in the same place.
        if (!isNotFound(error)) throw error;
        // Fork not reachable yet — wait and retry
        if (attempt < maxAttempts - 1) {
          await sleep(sleepMs);
        }
      }
    }

    // All polls exhausted — return what we got from the fork creation response.
    return {
      fullName: forkData.full_name,
      htmlUrl: forkData.html_url,
      defaultBranch: forkData.default_branch,
    };
  }

  async function deleteFile(args: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
  }): Promise<void> {
    const path = `/repos/${seg(args.owner)}/${seg(args.repo)}/contents/${filePath(args.path)}`;
    const existing = await request<GHFileContent>(
      "GET",
      `${path}?ref=${encodeURIComponent(args.branch)}`,
    );
    await request("DELETE", path, {
      sha: existing.sha,
      branch: args.branch,
      message: args.message,
    });
  }

  async function createBranch(args: {
    owner: string;
    repo: string;
    branch: string;
    fromBranch?: string;
    fromSha?: string;
  }): Promise<{ ref: string; sha: string }> {
    const repoPath = `/repos/${seg(args.owner)}/${seg(args.repo)}`;

    let sha = args.fromSha;
    if (!sha) {
      // When fromBranch is not provided, fetch the repo to discover default_branch.
      let baseBranch = args.fromBranch;
      if (!baseBranch) {
        const repo = await request<GHRepo>("GET", repoPath);
        baseBranch = repo.default_branch;
      }

      // A branch name may legitimately contain `/` (`feature/x`), so encode it
      // segment by segment rather than as one opaque value.
      const refData = await request<GHRef>(
        "GET",
        `${repoPath}/git/ref/heads/${filePath(baseBranch)}`,
      );
      sha = refData.object.sha;
    }

    const newRef = await request<GHRef>("POST", `${repoPath}/git/refs`, {
      ref: `refs/heads/${args.branch}`,
      sha,
    });

    return { ref: newRef.ref, sha: newRef.object.sha };
  }

  async function openPullRequest(args: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
    labels?: readonly string[];
  }): Promise<{ number: number; htmlUrl: string }> {
    const reqBody: Record<string, unknown> = {
      title: args.title,
      head: args.head,
      base: args.base,
    };
    if (args.body !== undefined) reqBody.body = args.body;
    if (args.draft !== undefined) reqBody.draft = args.draft;

    const data = await request<GHPull>(
      "POST",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls`,
      reqBody,
    );

    // A pull request is an issue to the labels endpoint, and the call needs
    // only the pull-request write the create already needed. The pull
    // request exists by now, so a label failure must not throw: a caller
    // with no adoption path would record nothing and open a second one on
    // retry. The failure is returned instead, and the missing label is
    // visible on the pull request itself.
    let labelError: string | undefined;
    if (args.labels !== undefined && args.labels.length > 0) {
      try {
        await request<unknown>(
          "POST",
          `/repos/${seg(args.owner)}/${seg(args.repo)}/issues/${data.number}/labels`,
          { labels: [...args.labels] },
        );
      } catch (err) {
        labelError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      number: data.number,
      htmlUrl: data.html_url,
      ...(labelError !== undefined ? { labelError } : {}),
    };
  }

  async function updatePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
    title?: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string }> {
    const data = await request<GHPull>(
      "PATCH",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls/${args.number}`,
      {
        ...(args.title !== undefined ? { title: args.title } : {}),
        body: args.body,
      },
    );
    return { number: data.number, htmlUrl: data.html_url };
  }

  async function createLabel(args: {
    owner: string;
    repo: string;
    name: string;
    color: string;
    description: string;
  }): Promise<"created" | "exists"> {
    try {
      await request<unknown>(
        "POST",
        `/repos/${seg(args.owner)}/${seg(args.repo)}/labels`,
        { name: args.name, color: args.color, description: args.description },
      );
      return "created";
    } catch (err) {
      // GitHub answers 422 when the repository already has a label of this
      // name, in any case. The color and description here are fixed and
      // valid, so a 422 means the name is taken.
      if (err instanceof GitHubApiError && err.status === 422) return "exists";
      throw err;
    }
  }

  async function addLabels(args: {
    owner: string;
    repo: string;
    number: number;
    labels: readonly string[];
  }): Promise<string[]> {
    const data = await request<GHLabel[]>(
      "POST",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/issues/${seg(args.number)}/labels`,
      { labels: [...args.labels] },
    );
    return data.map((label) => label.name);
  }

  async function listPullRequests(args: {
    owner: string;
    repo: string;
    head: string;
    state: "open" | "closed" | "all";
  }): Promise<{ number: number; htmlUrl: string }[]> {
    const query = new URLSearchParams({
      head: args.head,
      state: args.state,
      per_page: "100",
    });
    const data = await request<GHPull[]>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls?${query.toString()}`,
    );
    return data.map((pr) => ({ number: pr.number, htmlUrl: pr.html_url }));
  }

  async function getFileContent(args: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null> {
    const refQuery = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
    try {
      const data = await request<GHContentsFile>(
        "GET",
        `/repos/${seg(args.owner)}/${seg(args.repo)}/contents/${filePath(args.path)}${refQuery}`,
      );
      // GitHub encodes content as base64 with embedded newlines — strip them
      // before decoding.
      return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString(
        "utf8",
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * The commits that touched one path, newest first. GitHub answers 404 for a
   * repository with no commits at all, which is an empty history rather than a
   * failure, so that case returns `[]` like any other path nothing has touched.
   */
  async function listPathCommits(args: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
    limit?: number;
  }): Promise<GitHubPathCommit[]> {
    const query = new URLSearchParams({
      path: args.path,
      per_page: String(Math.min(Math.max(args.limit ?? 1, 1), 100)),
    });
    if (args.ref) query.set("sha", args.ref);
    try {
      const data = await request<GHCommitListItem[]>(
        "GET",
        `/repos/${seg(args.owner)}/${seg(args.repo)}/commits?${query.toString()}`,
      );
      return data.map((item) => ({
        sha: item.sha,
        authorName: item.commit.author?.name ?? "",
        authorLogin: item.author?.login ?? null,
        committedAt: item.commit.author?.date ?? "",
        summary: (item.commit.message ?? "").split("\n", 1)[0] ?? "",
        message: item.commit.message ?? "",
      }));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  /**
   * One branch's head commit, or null when GitHub answers 404: the branch
   * does not exist. Unlike `listBranches`, which stops at 300, this answers
   * for any branch by name.
   */
  async function getBranch(args: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<{ name: string; sha: string } | null> {
    try {
      const data = await request<GHBranch>(
        "GET",
        `/repos/${seg(args.owner)}/${seg(args.repo)}/branches/${encodeURIComponent(args.branch)}`,
      );
      return { name: args.branch, sha: data.commit.sha };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function getTree(args: {
    owner: string;
    repo: string;
    ref?: string;
    path?: string;
  }): Promise<string[]> {
    const ref = args.ref ?? "main";
    const repoPath = `/repos/${seg(args.owner)}/${seg(args.repo)}`;
    // Step 1 — resolve the ref to its commit's tree SHA. `/commits/{ref}`
    // takes a branch name, a tag or a commit SHA. `/branches/{ref}` takes a
    // branch name and nothing else, so every caller that named a commit —
    // which is what a caller does when it wants two reads to agree on one
    // commit — was answered 404.
    const commit = await request<GHBranchCommit>(
      "GET",
      `${repoPath}/commits/${encodeURIComponent(ref)}`,
    );
    let treeSha = commit.commit.tree.sha;
    // With a path, descend to that directory one non-recursive listing at a
    // time, so a caller that wants one directory of a large repository does
    // not page through all of it.
    const prefix = (args.path ?? "").replace(/^\/+|\/+$/g, "");
    if (prefix) {
      for (const part of prefix.split("/")) {
        const level = await request<GHTreeResponse>(
          "GET",
          `${repoPath}/git/trees/${seg(treeSha)}`,
        );
        const next = level.tree.find(
          (item) => item.type === "tree" && item.path === part,
        );
        if (!next) return [];
        treeSha = next.sha;
      }
      const under = await request<GHTreeResponse>(
        "GET",
        `${repoPath}/git/trees/${seg(treeSha)}?recursive=1`,
      );
      const paths = under.truncated
        ? await walkTree(repoPath, treeSha)
        : under.tree
            .filter((item) => item.type === "blob")
            .map((item) => item.path);
      return paths.map((p) => `${prefix}/${p}`);
    }
    // Step 2 — fetch the recursive tree.
    const treeData = await request<GHTreeResponse>(
      "GET",
      `${repoPath}/git/trees/${seg(treeSha)}?recursive=1`,
    );
    if (!treeData.truncated) {
      return treeData.tree
        .filter((item) => item.type === "blob")
        .map((item) => item.path);
    }
    // GitHub cuts a recursive tree at ~100,000 entries / 7 MB and flags it
    // `truncated` rather than failing. A partial list returned as complete
    // would tell an agent that files it cannot see do not exist, so walk the
    // tree one directory at a time instead: each non-recursive request lists
    // one directory, which no repository comes close to truncating.
    return walkTree(repoPath, treeSha);
  }

  async function walkTree(
    repoPath: string,
    rootSha: string,
  ): Promise<string[]> {
    const paths: string[] = [];
    const pending: Array<{ sha: string; prefix: string }> = [
      { sha: rootSha, prefix: "" },
    ];
    while (pending.length > 0) {
      const dir = pending.pop() as { sha: string; prefix: string };
      const data = await request<GHTreeResponse>(
        "GET",
        `${repoPath}/git/trees/${seg(dir.sha)}`,
      );
      if (data.truncated) {
        throw new Error(
          `GitHub truncated the listing of a single directory (${dir.prefix || "/"}) ` +
            `in ${repoPath}; the file tree cannot be listed completely.`,
        );
      }
      for (const item of data.tree) {
        const path = `${dir.prefix}${item.path}`;
        if (item.type === "blob") paths.push(path);
        else if (item.type === "tree")
          pending.push({ sha: item.sha, prefix: `${path}/` });
      }
    }
    return paths;
  }

  async function getPullRequest(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubPullRequest> {
    const data = await request<GHPullDetail>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls/${seg(args.number)}`,
    );
    return {
      number: data.number,
      title: data.title,
      htmlUrl: data.html_url,
      state: data.state,
      draft: data.draft ?? false,
      merged: data.merged ?? false,
      authorLogin: data.user?.login ?? null,
      authorAvatarUrl: data.user?.avatar_url ?? null,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      body: data.body,
      baseRef: data.base.ref,
      headRef: data.head.ref,
      headSha: data.head.sha,
      ...(data.head.repo === undefined
        ? {}
        : { headRepository: data.head.repo?.full_name ?? null }),
      mergeCommitSha: data.merge_commit_sha ?? null,
      mergedAt: data.merged_at ?? null,
      mergedBy: mergedByOf(data.merged_by),
      closedAt: data.closed_at ?? null,
      baseSha: data.base.sha ?? null,
      ...(data.base.repo
        ? {
            baseRepositoryId: String(data.base.repo.id),
            baseRepository: data.base.repo.full_name,
          }
        : {}),
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changed_files ?? 0,
      commits: data.commits ?? 0,
      commentCount: data.comments ?? 0,
      reviewCommentCount: data.review_comments ?? 0,
      labels: (data.labels ?? []).map((label) => label.name),
    };
  }

  /**
   * GraphQL lives beside REST: `https://api.github.com/graphql`, and on
   * GitHub Enterprise Server `/api/graphql` beside `/api/v3`.
   */
  const graphqlUrl = baseUrl.endsWith("/api/v3")
    ? `${baseUrl.slice(0, -"/v3".length)}/graphql`
    : `${baseUrl}/graphql`;

  async function listClosingIssues(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubClosingIssues> {
    const data = await request<GHClosingIssuesResponse>("POST", graphqlUrl, {
      query: CLOSING_ISSUES_QUERY,
      variables: { owner: args.owner, repo: args.repo, number: args.number },
    });
    // GraphQL answers 200 with `errors` for a query it refused; a missing
    // pull request is one of those. Reported as an error, never as "closes
    // nothing", which would read as a fact.
    const refs = data.data?.repository?.pullRequest?.closingIssuesReferences;
    if (!refs) {
      throw new GitHubApiError(
        200,
        data.errors?.[0]?.message ?? "closingIssuesReferences was not returned",
      );
    }
    return {
      issues: refs.nodes.map((node) => ({
        owner: node.repository.owner.login,
        repo: node.repository.name,
        number: node.number,
        title: node.title,
        url: node.url,
        state: node.state === "OPEN" ? "open" : "closed",
      })),
      complete: refs.totalCount <= refs.nodes.length,
    };
  }

  async function listPullRequestComments(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubPrComments> {
    const repoPath = `/repos/${seg(args.owner)}/${seg(args.repo)}`;
    const number = seg(args.number);
    const [issueRaw, reviewRaw] = await Promise.all([
      request<GHIssueComment[]>(
        "GET",
        `${repoPath}/issues/${number}/comments?per_page=100`,
      ),
      request<GHReviewComment[]>(
        "GET",
        `${repoPath}/pulls/${number}/comments?per_page=100`,
      ),
    ]);

    const issue: GitHubPrComment[] = issueRaw.map((c) => ({
      id: String(c.id),
      authorLogin: c.user?.login ?? null,
      authorAvatarUrl: c.user?.avatar_url ?? null,
      body: c.body ?? "",
      createdAt: c.created_at,
      htmlUrl: c.html_url,
      path: null,
    }));

    const review: GitHubPrComment[] = reviewRaw.map((c) => ({
      id: String(c.id),
      authorLogin: c.user?.login ?? null,
      authorAvatarUrl: c.user?.avatar_url ?? null,
      body: c.body ?? "",
      createdAt: c.created_at,
      htmlUrl: c.html_url,
      path: c.path,
    }));

    return { issue, review };
  }

  async function listCiChecks(args: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<GitHubCiChecks> {
    const ref = encodeURIComponent(args.ref);
    const repoPath = `/repos/${seg(args.owner)}/${seg(args.repo)}`;
    const [checksRes, statusRes] = await Promise.all([
      request<GHCheckRunsResponse>(
        "GET",
        `${repoPath}/commits/${ref}/check-runs?per_page=100`,
      ),
      request<GHCombinedStatus>(
        "GET",
        `${repoPath}/commits/${ref}/status?per_page=100`,
      ),
    ]);

    const allChecks = [...checksRes.check_runs];
    const allStatuses = [...statusRes.statuses];
    let checkPage = checksRes.check_runs.length;
    let statusPage = statusRes.statuses.length;
    for (
      let page = 2;
      page <= 10 &&
      (allChecks.length < checksRes.total_count || statusPage === 100);
      page++
    ) {
      const [checks, statuses] = await Promise.all([
        allChecks.length < checksRes.total_count
          ? request<GHCheckRunsResponse>(
              "GET",
              `${repoPath}/commits/${ref}/check-runs?per_page=100&page=${page}`,
            )
          : Promise.resolve(null),
        statusPage === 100
          ? request<GHCombinedStatus>(
              "GET",
              `${repoPath}/commits/${ref}/status?per_page=100&page=${page}`,
            )
          : Promise.resolve(null),
      ]);
      if (checks) {
        allChecks.push(...checks.check_runs);
        checkPage = checks.check_runs.length;
      }
      if (statuses) {
        allStatuses.push(...statuses.statuses);
        statusPage = statuses.statuses.length;
      }
      if (checkPage === 0 && statusPage < 100) break;
    }
    const complete =
      allChecks.length >= checksRes.total_count && statusPage < 100;
    const checkRuns: GitHubCheckRun[] = allChecks.map((r) => ({
      name: r.name,
      status: normaliseCheckStatus(r.status),
      conclusion: normaliseConclusion(r.conclusion),
      detailsUrl: r.details_url,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      appName: r.app?.name ?? null,
    }));

    const statuses: GitHubCommitStatus[] = allStatuses.map((s) => ({
      context: s.context,
      state: normaliseStatusState(s.state),
      targetUrl: s.target_url,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));

    // Prefer the SHA from the combined-status endpoint; it always resolves the
    // ref to a concrete commit.
    return { sha: statusRes.sha, checkRuns, statuses, complete };
  }

  /**
   * The checks a branch requires, from classic protection and from rulesets.
   * An acceptance gate opens on a person's ticks when this answers an empty
   * list, so every read that fails answers `ok: false` instead.
   */
  async function getRequiredStatusChecks(args: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<RequiredChecksRead> {
    const repoPath = `/repos/${seg(args.owner)}/${seg(args.repo)}`;
    // A branch name may contain `/`; it is encoded as one segment, as
    // `getBranch` does.
    const branch = encodeURIComponent(args.branch);
    const [protection, rulesets] = await Promise.all([
      readProtectionChecks(`${repoPath}/branches/${branch}`),
      readRulesetChecks(`${repoPath}/rules/branches/${branch}`),
    ]);
    if (!protection.ok || !rulesets.ok) {
      const reasons = [protection, rulesets].flatMap((read) =>
        read.ok ? [] : [read.reason],
      );
      return { ok: false, reason: reasons.join("; ") };
    }
    return {
      ok: true,
      names: [...new Set([...protection.names, ...rulesets.names])].sort(),
      sources: { protection: protection.present, rulesets: rulesets.present },
    };
  }

  /**
   * Classic protection's required checks, from the branch's own summary
   * (`GET /branches/{branch}`). That endpoint needs only read access, where
   * `/branches/{branch}/protection` needs the App's `Administration: read`.
   */
  async function readProtectionChecks(
    path: string,
  ): Promise<RequiredChecksSourceRead> {
    let body: unknown;
    try {
      body = await request<unknown>("GET", path);
    } catch (err) {
      // A cancelled operation is reported as the cancellation, as in
      // `forkRepo`, never as a failed read. A 404 means GitHub would not
      // show the branch or the repository, which is a failed read too.
      opts.signal?.throwIfAborted();
      return { ok: false, reason: `protection read failed: ${failureOf(err)}` };
    }
    return branchProtectionChecks(body);
  }

  async function readRulesetChecks(
    path: string,
  ): Promise<RequiredChecksSourceRead> {
    const names: string[] = [];
    let present = false;
    for (let page = 1; page <= BRANCH_RULES_MAX_PAGES; page++) {
      let body: unknown;
      try {
        body = await request<unknown>(
          "GET",
          `${path}?per_page=${BRANCH_RULES_PER_PAGE}&page=${page}`,
        );
      } catch (err) {
        opts.signal?.throwIfAborted();
        // A 404 here means GitHub would not show the repository or the
        // branch's rules. That says nothing about what the branch requires.
        return { ok: false, reason: `rulesets read failed: ${failureOf(err)}` };
      }
      if (!isUnknownArray(body)) {
        return { ok: false, reason: "rulesets read failed: malformed body" };
      }
      const rules = requiredCheckRules(body);
      if (rules === null) {
        return { ok: false, reason: "rulesets read failed: malformed body" };
      }
      if (rules.found) present = true;
      names.push(...rules.names);
      // An under-full page is the last one.
      if (body.length < BRANCH_RULES_PER_PAGE) {
        return { ok: true, names, present };
      }
    }
    return {
      ok: false,
      reason: `rulesets read failed: more than ${BRANCH_RULES_MAX_PAGES} pages`,
    };
  }

  async function listPullRequestFiles(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubPrFile[]> {
    const data = await request<GHPullFile[]>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls/${seg(args.number)}/files?per_page=100`,
    );
    return data.map(toPrFile);
  }

  async function compareCommits(args: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<GitHubPrFile[]> {
    const data = await request<{ files?: GHPullFile[] }>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
    );
    return (data.files ?? []).map(toPrFile);
  }

  async function compareRefs(args: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<GitHubCompareRefs> {
    const data = await request<{
      merge_base_commit?: { sha?: string | null } | null;
      files?: GHPullFile[];
    }>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
    );
    const files = (data.files ?? []).map(toPrFile);
    return {
      mergeBaseSha: data.merge_base_commit?.sha ?? null,
      files,
      filesTruncated: files.length >= COMPARE_FILES_MAX,
    };
  }

  async function getCompareDiff(args: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    maxBytes: number;
  }): Promise<GitHubCompareDiff> {
    let res: Response;
    try {
      res = await send(
        "GET",
        `/repos/${seg(args.owner)}/${seg(args.repo)}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
        undefined,
        "application/vnd.github.diff",
      );
    } catch (err) {
      // GitHub refuses a diff over its own limits (406, or 422 on a compare)
      // and times out on one it cannot render in time (500 with a timeout
      // message). Each is a diff too large to have, not a fault to retry.
      if (err instanceof GitHubApiError && diffRefused(err)) {
        return { status: "too_large", reason: "forge_refused" };
      }
      throw err;
    }
    const bytes = await readCapped(res, args.maxBytes);
    return bytes === null
      ? { status: "too_large", reason: "over_cap" }
      : { status: "ok", bytes };
  }

  async function findOpenPullRequest(args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
  }): Promise<{ number: number; htmlUrl: string; body: string } | null> {
    const query = `state=open&head=${encodeURIComponent(`${args.owner}:${args.head}`)}&base=${encodeURIComponent(args.base)}`;
    const data = await request<GHPull[]>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls?${query}`,
    );
    const pr = data[0];
    return pr
      ? { number: pr.number, htmlUrl: pr.html_url, body: pr.body ?? "" }
      : null;
  }

  async function listInstallationRepositories(
    options: { maxPages?: number } = {},
  ): Promise<GitHubInstallationRepositories> {
    const maxPages = Math.max(1, Math.floor(options.maxPages ?? MAX_PAGES));
    const repositories: GitHubInstallationRepo[] = [];
    // GitHub reports the installation's true total on every page; the last
    // page read is the figure `truncated` is judged against.
    let totalCount = 0;

    for (let page = 1; page <= maxPages; page++) {
      const data = await request<GHInstallationReposResponse>(
        "GET",
        `/installation/repositories?per_page=${INSTALLATION_REPOS_PER_PAGE}&page=${page}`,
      );
      const batch = data.repositories ?? [];
      repositories.push(
        ...batch.map((r) => ({
          // GitHub's numeric repository id survives renames and transfers; it
          // is what a repository binding pins.
          id: String(r.id),
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          private: r.private,
        })),
      );
      totalCount =
        typeof data.total_count === "number"
          ? data.total_count
          : repositories.length;
      // Short-circuit once a page comes back under-full — the next page is
      // empty, and an extra round trip on every settings read is not free.
      if (batch.length < INSTALLATION_REPOS_PER_PAGE) break;
    }

    return { repositories, truncated: totalCount > repositories.length };
  }

  async function listBranches(args: {
    owner: string;
    repo: string;
  }): Promise<GitHubBranch[]> {
    const perPage = 100;
    const maxPages = 3;
    const branches: GitHubBranch[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const data = await request<GHBranchListItem[]>(
        "GET",
        `/repos/${seg(args.owner)}/${seg(args.repo)}/branches?per_page=${perPage}&page=${page}`,
      );
      branches.push(
        ...data.map((b) => ({
          name: b.name,
          sha: b.commit.sha,
          protected: b.protected,
        })),
      );
      // Short-circuit once a page comes back under-full — no need to fetch
      // further pages that would return empty.
      if (data.length < perPage) break;
    }

    return branches;
  }

  async function createCheckRun(
    args: GitHubCheckRunArgs,
  ): Promise<{ id: number; htmlUrl: string }> {
    // GitHub refuses a conclusion or an end time on a run that is still going.
    const state =
      args.status === "in_progress"
        ? { status: "in_progress", started_at: args.startedAt }
        : {
            status: "completed",
            conclusion: args.conclusion,
            started_at: args.startedAt,
            completed_at: args.completedAt,
          };
    const data = await request<GHCheckRun>(
      "POST",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/check-runs`,
      {
        name: args.name,
        head_sha: args.headSha,
        ...state,
        ...(args.detailsUrl === undefined ? {} : { details_url: args.detailsUrl }),
        ...(args.externalId === undefined ? {} : { external_id: args.externalId }),
        output: {
          title: args.title,
          summary: args.summary,
          ...(args.text === undefined ? {} : { text: args.text }),
        },
      },
    );
    return { id: data.id, htmlUrl: data.html_url };
  }

  async function mergePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    sha?: string;
  }): Promise<{ sha: string; merged: boolean }> {
    const body: Record<string, unknown> = {};
    if (args.mergeMethod !== undefined) body.merge_method = args.mergeMethod;
    if (args.commitTitle !== undefined) body.commit_title = args.commitTitle;
    if (args.sha !== undefined) body.sha = args.sha;
    const data = await request<GHMerge>(
      "PUT",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls/${args.number}/merge`,
      body,
    );
    return { sha: data.sha, merged: data.merged };
  }

  async function closePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<void> {
    await request<GHPull>(
      "PATCH",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls/${seg(args.number)}`,
      { state: "closed" },
    );
  }

  async function deleteBranch(args: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<void> {
    await request<void>(
      "DELETE",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/git/refs/heads/${filePath(args.branch)}`,
    );
  }

  /**
   * Each issue's title and state by number, in one GraphQL call that aliases
   * `issueOrPullRequest(number:)` once per number (#3970). GitHub numbers
   * issues and pull requests from one sequence, so a number can name a pull
   * request: it is returned with `isPullRequest: true`, and the caller decides
   * what to do with it. A number GitHub does not resolve is in `missing`. A
   * refused query (no such repository, no access) throws, and never reads as
   * every issue missing.
   */
  async function getIssues(args: {
    owner: string;
    repo: string;
    numbers: readonly number[];
  }): Promise<GitHubIssueStates> {
    const numbers = [...new Set(args.numbers)].filter(
      (n) => Number.isSafeInteger(n) && n > 0,
    );
    if (numbers.length > ISSUES_PER_QUERY) {
      throw new RangeError(
        `getIssues reads at most ${String(ISSUES_PER_QUERY)} issues per call, got ${String(numbers.length)}`,
      );
    }
    if (numbers.length === 0) return { issues: [], missing: [] };
    // The numbers are validated integers, so they are safe to inline; an
    // alias cannot take a variable.
    const fields = numbers
      .map(
        (n) =>
          `n${String(n)}: issueOrPullRequest(number: ${String(n)}) { __typename ... on Issue { number title url state stateReason } ... on PullRequest { number title url state } }`,
      )
      .join("\n");
    const data = await request<GHIssuesResponse>("POST", graphqlUrl, {
      query: `query ($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) {\n${fields}\n  }\n}`,
      variables: { owner: args.owner, repo: args.repo },
    });
    const repository = data.data?.repository;
    if (!repository) {
      throw new GitHubApiError(
        200,
        data.errors?.[0]?.message ?? "repository was not returned",
      );
    }
    const issues: GitHubIssueStates["issues"] = [];
    const missing: number[] = [];
    for (const n of numbers) {
      const node = repository[`n${String(n)}`];
      if (!node) {
        missing.push(n);
        continue;
      }
      const isPullRequest = node.__typename === "PullRequest";
      issues.push({
        number: node.number,
        title: node.title,
        state: node.state === "OPEN" ? "open" : "closed",
        stateReason: isPullRequest ? null : stateReasonOf(node.stateReason),
        url: node.url,
        isPullRequest,
      });
    }
    return { issues, missing };
  }

  /**
   * The repository's first 100 releases, newest first, drafts included for a
   * token with push access (`GET /repos/{owner}/{repo}/releases`, #3890). A
   * draft has no tag on the repository yet, which is why a release is found in
   * this list rather than through `releases/tags/{tag}`.
   */
  async function listReleases(args: {
    owner: string;
    repo: string;
  }): Promise<GitHubRelease[]> {
    const data = await request<GHRelease[]>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/releases?per_page=100`,
    );
    return data.map((release) => ({
      tagName: release.tag_name,
      name: release.name ? release.name : null,
      htmlUrl: release.html_url,
      draft: release.draft,
      prerelease: release.prerelease,
      publishedAt: release.published_at ?? null,
    }));
  }

  return {
    getAuthenticatedUser,
    getRepoInfo,
    createRepoInOrg,
    putFile,
    deleteFile,
    forkRepo,
    createBranch,
    openPullRequest,
    updatePullRequest,
    createLabel,
    addLabels,
    listPullRequests,
    getFileContent,
    listPathCommits,
    getTree,
    getBranch,
    getPullRequest,
    listClosingIssues,
    getIssues,
    listReleases,
    listPullRequestComments,
    listCiChecks,
    getRequiredStatusChecks,
    listPullRequestFiles,
    compareCommits,
    compareRefs,
    getCompareDiff,
    findOpenPullRequest,
    listBranches,
    listInstallationRepositories,
    createCheckRun,
    mergePullRequest,
    closePullRequest,
    deleteBranch,
  };
}

// ---------------------------------------------------------------------------
// Normalisers — coerce loose GitHub string enums to our typed unions
// ---------------------------------------------------------------------------

function normaliseCheckStatus(status: string): GitHubCheckRun["status"] {
  return status === "queued" || status === "in_progress" ? status : "completed";
}

function normaliseConclusion(
  conclusion: string | null,
): GitHubCheckRun["conclusion"] {
  switch (conclusion) {
    case "success":
    case "failure":
    case "neutral":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "skipped":
    case "stale":
      return conclusion;
    default:
      return null;
  }
}

function normaliseStatusState(state: string): GitHubCommitStatus["state"] {
  switch (state) {
    case "error":
    case "failure":
    case "pending":
    case "success":
      return state;
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Required-check body parsers
// ---------------------------------------------------------------------------

/** The short cause a failed read reports: the HTTP status, or the error text. */
function failureOf(err: unknown): string {
  if (err instanceof GitHubApiError) return String(err.status);
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Each entry's `context`, or null when an entry is not `{ context: string }`. */
function contextsOf(entries: unknown): string[] | null {
  if (!isUnknownArray(entries)) return null;
  const names: string[] = [];
  for (const entry of entries) {
    const context = isRecord(entry) ? entry.context : undefined;
    if (typeof context !== "string") return null;
    names.push(context);
  }
  return names;
}

/**
 * Classic protection's required checks, read from the `protected` flag and
 * the `protection` summary of a `GET /branches/{branch}` body:
 *
 * - `protected: false`: nothing required.
 * - `protected: true` with no `protection` summary: GitHub did not say what
 *   the branch requires, so the read fails.
 * - A summary with no `required_status_checks`, or with an enforcement level
 *   of "off": nothing required.
 * - Any other enforcement level: `contexts` and every `checks[].context`. A
 *   level this client does not know counts as enforced.
 */
function branchProtectionChecks(body: unknown): RequiredChecksSourceRead {
  const malformed: RequiredChecksSourceRead = {
    ok: false,
    reason: "protection read failed: malformed body",
  };
  const none: RequiredChecksSourceRead = {
    ok: true,
    names: [],
    present: false,
  };
  if (!isRecord(body)) return malformed;
  const isProtected = body.protected;
  if (typeof isProtected !== "boolean") return malformed;
  if (!isProtected) return none;
  const protection = body.protection;
  if (protection === undefined || protection === null) {
    return { ok: false, reason: "protection summary unreadable" };
  }
  if (!isRecord(protection) || typeof protection.enabled !== "boolean") {
    return malformed;
  }
  const required = protection.required_status_checks;
  if (required === undefined) return none;
  if (!isRecord(required)) return malformed;
  const level = required.enforcement_level;
  if (typeof level !== "string") return malformed;
  if (level === "off") return none;
  const names = requiredStatusCheckNames(required);
  return names === null ? malformed : { ok: true, names, present: true };
}

/**
 * The names a `required_status_checks` setting lists, from `contexts` and
 * from each `checks[].context`, or null for a setting of the wrong shape.
 */
function requiredStatusCheckNames(
  required: Record<string, unknown>,
): string[] | null {
  const listed = required.contexts;
  if (!isUnknownArray(listed)) return null;
  const contexts: string[] = [];
  for (const context of listed) {
    if (typeof context !== "string") return null;
    contexts.push(context);
  }
  // `checks` repeats `contexts` with the app each check must come from. An
  // older GitHub Enterprise Server leaves it out.
  const checks =
    required.checks === undefined ? [] : contextsOf(required.checks);
  if (checks === null) return null;
  return [...contexts, ...checks];
}

/**
 * The names the `required_status_checks` rules on one page require, or null
 * for a page of the wrong shape. Other rule types are skipped. `found` is
 * true when the page holds at least one such rule.
 */
function requiredCheckRules(
  rules: readonly unknown[],
): { names: string[]; found: boolean } | null {
  const names: string[] = [];
  let found = false;
  for (const rule of rules) {
    if (!isRecord(rule)) return null;
    const type = rule.type;
    if (typeof type !== "string") return null;
    if (type !== "required_status_checks") continue;
    const parameters = rule.parameters;
    if (!isRecord(parameters)) return null;
    const contexts = contextsOf(parameters.required_status_checks);
    if (contexts === null) return null;
    found = true;
    names.push(...contexts);
  }
  return { names, found };
}

/** The most files GitHub's compare answers with. */
const COMPARE_FILES_MAX = 300;

/** A refusal that means the diff is too large to render, not a fault. */
function diffRefused(err: GitHubApiError): boolean {
  if (err.status === 406 || err.status === 422) return true;
  return err.status === 500 && /timed? ?out|too (large|big)|diff/i.test(err.message);
}

/**
 * The body's bytes, or null once they pass `max`. The read stops there, so a
 * diff of any size costs at most `max` bytes of memory.
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as {
      done: boolean;
      value?: Uint8Array;
    };
    if (done || value === undefined) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function toPrFile(f: GHPullFile): GitHubPrFile {
  return {
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: normaliseFileStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch ?? null,
  };
}

function normaliseFileStatus(status: string): GitHubPrFile["status"] {
  switch (status) {
    case "added":
    case "modified":
    case "removed":
    case "renamed":
    case "copied":
    case "changed":
      return status;
    default:
      return "changed";
  }
}
