import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCiChecks,
  GitHubClient,
  GitHubClientOptions,
  GitHubCommitStatus,
  GitHubPrComment,
  GitHubPrComments,
  GitHubPrFile,
  GitHubPullRequest,
} from "./types";

// ---------------------------------------------------------------------------
// GitHub API response shapes — internal use only
// ---------------------------------------------------------------------------

interface GHUser {
  login: string;
}

interface GHRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
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
}

interface GHErrorBody {
  message?: string;
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

interface GHBranchListItem {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_SLEEP_MS = 1500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  const sleep = opts.sleep ?? defaultSleep;
  const sleepMs = opts.sleepMs ?? DEFAULT_SLEEP_MS;

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
    const res = await fetch(url, {
      method,
      headers: commonHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      let message = res.statusText;
      try {
        const err = (await res.json()) as GHErrorBody;
        if (err.message) message = err.message;
      } catch {
        // fallback to statusText
      }
      throw new Error(`GitHub API error ${res.status}: ${message}`);
    }

    return res.json() as Promise<T>;
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
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }> {
    const data = await request<GHRepo>(
      "GET",
      `/repos/${seg(args.owner)}/${seg(args.repo)}`,
    );
    return {
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
    } catch {
      // 404 → file does not exist; any other error swallowed (create path handles it)
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
        return {
          fullName: data.full_name,
          htmlUrl: data.html_url,
          defaultBranch: data.default_branch,
        };
      } catch {
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

    return { number: data.number, htmlUrl: data.html_url };
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
      if (err instanceof Error && err.message.includes("404")) return null;
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
    // Step 1 — resolve branch → tree SHA via the branches endpoint.
    const branch = await request<GHBranch>(
      "GET",
      `${repoPath}/branches/${encodeURIComponent(ref)}`,
    );
    const treeSha = branch.commit.commit.tree.sha;
    // Step 2 — fetch the recursive tree.
    const treeData = await request<GHTreeResponse>(
      "GET",
      `${repoPath}/git/trees/${seg(treeSha)}?recursive=1`,
    );
    return treeData.tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path);
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
    return data.map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: normaliseFileStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch ?? null,
    }));
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

  return {
    getAuthenticatedUser,
    getRepoInfo,
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
    getFileContent,
    getTree,
    getPullRequest,
    listPullRequestComments,
    listCiChecks,
    listPullRequestFiles,
    listBranches,
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
