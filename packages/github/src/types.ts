/** A pull request's core fields, normalised from the GitHub REST payload. */
export interface GitHubPullRequest {
  number: number;
  title: string;
  htmlUrl: string;
  /** Raw GitHub state — merged is derived separately via `merged`. */
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  /** True total of issue (conversation) comments. */
  commentCount: number;
  /** True total of inline review comments. */
  reviewCommentCount: number;
}

/** A single PR comment, normalised across issue and review comment endpoints. */
export interface GitHubPrComment {
  id: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  body: string;
  createdAt: string;
  htmlUrl: string | null;
  /** File path for review comments; null for issue comments. */
  path: string | null;
}

/** Both comment streams for a PR, kept separate so callers can tag `kind`. */
export interface GitHubPrComments {
  issue: GitHubPrComment[];
  review: GitHubPrComment[];
}

/** A GitHub Checks API check run. */
export interface GitHubCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | "stale"
    | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  appName: string | null;
}

/** A legacy commit-status context from the combined status endpoint. */
export interface GitHubCommitStatus {
  context: string;
  /** GitHub statuses report state, not the richer check conclusion. */
  state: "error" | "failure" | "pending" | "success";
  targetUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Merged CI signal for a ref: resolved SHA plus both check streams. */
export interface GitHubCiChecks {
  sha: string | null;
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
}

/** A single file entry from the PR files endpoint. */
export interface GitHubPrFile {
  path: string;
  previousPath: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
}

/** A single branch entry from the branch listing endpoint. */
export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

/**
 * Vendor-neutral interface for GitHub write operations.
 * Swap the backing by providing a different createGitHubClient
 * implementation without changing callers.
 */
export interface GitHubClient {
  /**
   * Create a new repository.
   *
   * When `org` is provided the repository is created inside that GitHub
   * organisation (`POST /orgs/{org}/repos`). When `org` is omitted it is
   * created in the authenticated user's personal account
   * (`POST /user/repos`) — `POST /orgs/{user}/repos` 404s for a personal
   * account, so the two endpoints are not interchangeable.
   */
  createRepoInOrg(args: {
    org?: string;
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }>;

  /**
   * Create or update a single file in a repository.
   * `content` is the raw UTF-8 string — base64 encoding is handled internally.
   */
  putFile(args: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
  }): Promise<{ commitSha: string; htmlUrl: string }>;

  /**
   * Fork a repository into the authenticated user's account or into `org`.
   * Polls until the fork is reachable (up to 10 attempts).
   */
  forkRepo(args: {
    owner: string;
    repo: string;
    org?: string;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }>;

  /**
   * Create a new branch from an existing branch (default: main).
   */
  createBranch(args: {
    owner: string;
    repo: string;
    branch: string;
    fromBranch?: string;
  }): Promise<{ ref: string; sha: string }>;

  /**
   * Open a pull request.
   */
  openPullRequest(args: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }): Promise<{ number: number; htmlUrl: string }>;

  /**
   * Return the login of the authenticated user.
   */
  getAuthenticatedUser(): Promise<{ login: string }>;

  /**
   * Return basic repository metadata, including the default branch — the
   * lookup behind the never-write-to-default-branch guard.
   */
  getRepoInfo(args: {
    owner: string;
    repo: string;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }>;

  /**
   * Return the raw UTF-8 content of a file at the given path and optional ref.
   * Returns `null` when the file does not exist (HTTP 404).
   */
  getFileContent(args: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null>;

  /**
   * Return all blob paths in the repository tree at the given ref (defaults to
   * the repository default branch). The returned paths are relative to the
   * repository root (e.g. `"src/index.ts"`).
   */
  getTree(args: {
    owner: string;
    repo: string;
    ref?: string;
  }): Promise<string[]>;

  /**
   * Fetch a single pull request's details (stats, refs, comment totals).
   */
  getPullRequest(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubPullRequest>;

  /**
   * List a PR's issue (conversation) comments and inline review comments.
   * Fetches up to 100 of each; callers cap and sort as needed.
   */
  listPullRequestComments(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubPrComments>;

  /**
   * Fetch check runs and legacy combined statuses for a ref, resolving the ref
   * to its commit SHA first. Both streams are returned for the caller to merge.
   */
  listCiChecks(args: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<GitHubCiChecks>;

  /**
   * List the files changed in a pull request with per-file patch and stats.
   * Fetches up to 100 files (one page).
   */
  listPullRequestFiles(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<GitHubPrFile[]>;

  /**
   * List branches in a repository, paginated up to 300 branches (3 pages of
   * 100). Stops early once a page returns fewer than 100 entries.
   */
  listBranches(args: { owner: string; repo: string }): Promise<GitHubBranch[]>;
}

/** Options accepted by createGitHubClient. */
export interface GitHubClientOptions {
  /** Personal access token or GitHub App installation token. */
  token: string;
  /** Override the GitHub API base URL (e.g. for GitHub Enterprise). */
  baseUrl?: string;
  /**
   * Milliseconds to sleep between fork-polling attempts.
   * Defaults to 1500. Set to 0 in tests via the injectable `sleep` below.
   */
  sleepMs?: number;
  /**
   * Injectable sleep function — primarily for test injection.
   * Defaults to a real `setTimeout`-based implementation.
   */
  sleep?: (ms: number) => Promise<void>;
}
