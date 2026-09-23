import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCiChecks,
  GitHubClient,
  GitHubClientOptions,
  GitHubInstallationRepo,
  GitHubInstallationRepositories,
  GitHubCommitStatus,
  GitHubPrComment,
  GitHubPrComments,
  GitHubPathCommit,
  GitHubPrFile,
  GitHubPullRequest,
  GitHubRepoInfo,
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
  base: { ref: string };
  head: { ref: string; sha: string | null };
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  comments?: number;
  review_comments?: number;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.github.com";
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
    const url = `${baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, timeout])
        : timeout;
      const res = await fetch(url, {
        method,
        headers: commonHeaders,
        signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return res.json() as Promise<T>;
      }
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
  }): Promise<{ ref: string; sha: string }> {
    const repoPath = `/repos/${seg(args.owner)}/${seg(args.repo)}`;

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

    const newRef = await request<GHRef>("POST", `${repoPath}/git/refs`, {
      ref: `refs/heads/${args.branch}`,
      sha: refData.object.sha,
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
    title: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string }> {
    const data = await request<GHPull>(
      "PATCH",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls/${args.number}`,
      { title: args.title, body: args.body },
    );
    return { number: data.number, htmlUrl: data.html_url };
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
    const treeSha = commit.commit.tree.sha;
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
      mergeCommitSha: data.merge_commit_sha ?? null,
      mergedAt: data.merged_at ?? null,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changed_files ?? 0,
      commits: data.commits ?? 0,
      commentCount: data.comments ?? 0,
      reviewCommentCount: data.review_comments ?? 0,
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

    const checkRuns: GitHubCheckRun[] = checksRes.check_runs.map((r) => ({
      name: r.name,
      status: normaliseCheckStatus(r.status),
      conclusion: normaliseConclusion(r.conclusion),
      detailsUrl: r.details_url,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      appName: r.app?.name ?? null,
    }));

    const statuses: GitHubCommitStatus[] = statusRes.statuses.map((s) => ({
      context: s.context,
      state: normaliseStatusState(s.state),
      targetUrl: s.target_url,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));

    // Prefer the SHA from the combined-status endpoint; it always resolves the
    // ref to a concrete commit.
    return { sha: statusRes.sha, checkRuns, statuses };
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

  async function listInstallationRepositories(): Promise<GitHubInstallationRepositories> {
    const repositories: GitHubInstallationRepo[] = [];
    // GitHub reports the installation's true total on every page; the last
    // page read is the figure `truncated` is judged against.
    let totalCount = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
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

  async function createCheckRun(args: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
    startedAt: string;
    completedAt: string;
  }): Promise<{ id: number; htmlUrl: string }> {
    const data = await request<GHCheckRun>(
      "POST",
      `/repos/${seg(args.owner)}/${seg(args.repo)}/check-runs`,
      {
        name: args.name,
        head_sha: args.headSha,
        status: "completed",
        conclusion: args.conclusion,
        started_at: args.startedAt,
        completed_at: args.completedAt,
        output: { title: args.title, summary: args.summary },
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
    listPullRequests,
    getFileContent,
    listPathCommits,
    getTree,
    getBranch,
    getPullRequest,
    listPullRequestComments,
    listCiChecks,
    listPullRequestFiles,
    compareCommits,
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
