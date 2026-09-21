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
  /** The merge commit once `merged` is true; null before. */
  mergeCommitSha: string | null;
  /** When GitHub merged it (ISO 8601), once `merged` is true; null before. */
  mergedAt: string | null;
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
export interface GitHubRepoInfo {
  /** GitHub's numeric repository id, as text; immutable across renames and transfers. */
  id: string;
  /** The owner login and repository name as GitHub reports them. */
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
}

/**
 * A repository as the installation-repositories listing reports it: the same
 * identity `GitHubRepoInfo` carries, plus the visibility a picker shows so a
 * person can tell two same-named repositories apart.
 */
export interface GitHubInstallationRepo extends GitHubRepoInfo {
  private: boolean;
}

/**
 * One bounded walk of `GET /installation/repositories`. `truncated` is true
 * when the installation reaches more repositories than the walk collected —
 * honest rather than paginated, so a caller tells the person to narrow the
 * App's repository access instead of silently hiding a repository.
 */
export interface GitHubInstallationRepositories {
  repositories: GitHubInstallationRepo[];
  truncated: boolean;
}

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

  /** Delete a file from a branch using its current blob SHA. */
  deleteFile(args: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
  }): Promise<void>;

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

  /** Refresh submission metadata without changing the pull request identity or branches. */
  updatePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    body: string;
  }): Promise<{ number: number; htmlUrl: string }>;

  /**
   * List pull requests, narrowed by head branch and state. `head` is
   * `owner:branch`, the filter GitHub applies to `GET /pulls`. The one
   * `POST /pulls` refuses with 422 — a head that already has an open pull
   * request — is the one this finds first.
   */
  listPullRequests(args: {
    owner: string;
    repo: string;
    head: string;
    state: "open" | "closed" | "all";
  }): Promise<{ number: number; htmlUrl: string }[]>;

  /**
   * Return the login of the authenticated user.
   */
  getAuthenticatedUser(): Promise<{ login: string }>;

  /**
   * Return basic repository metadata, including the default branch — the
   * lookup behind the never-write-to-default-branch guard — and the numeric
   * repository id a binding pins.
   */
  getRepoInfo(args: { owner: string; repo: string }): Promise<GitHubRepoInfo>;

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
   * the repository default branch). The ref may be a branch name, a tag or a
   * commit SHA; name the commit when two reads have to agree on one. The
   * returned paths are relative to the repository root (e.g. `"src/index.ts"`).
   */
  getTree(args: {
    owner: string;
    repo: string;
    ref?: string;
  }): Promise<string[]>;

  /**
   * One branch's head commit by name, or null when the branch does not exist
   * (HTTP 404). Any other refusal surfaces as the thrown error.
   */
  getBranch(args: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<{ name: string; sha: string } | null>;

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
   * List the files changed between `base` and `head` as a pull request shows
   * them: GitHub's three-dot compare, from the merge base to `head`. GitHub
   * returns up to 300 files.
   */
  compareCommits(args: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<GitHubPrFile[]>;

  /**
   * The open pull request from `head` (a branch in this repository) into
   * `base`, with its body ("" when it has none), or null when there is none.
   */
  findOpenPullRequest(args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
  }): Promise<{ number: number; htmlUrl: string; body: string } | null>;

  /**
   * List branches in a repository, paginated up to 300 branches (3 pages of
   * 100). Stops early once a page returns fewer than 100 entries.
   */
  listBranches(args: { owner: string; repo: string }): Promise<GitHubBranch[]>;

  /**
   * Create a completed check run on a commit (Checks API). Needs a GitHub App
   * installation token with `checks: write`; an OAuth or personal token is
   * refused by GitHub with 403, which surfaces as the thrown error.
   */
  createCheckRun(args: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
    startedAt: string;
    completedAt: string;
  }): Promise<{ id: number; htmlUrl: string }>;

  /**
   * Merge a pull request. `sha` pins the merge to that head commit: GitHub
   * refuses with 409 when the head has moved past it. GitHub refuses with 405
   * when a required review or status is missing, or the PR is already
   * merged; every refusal surfaces as the thrown error with GitHub's message.
   */
  mergePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    sha?: string;
  }): Promise<{ sha: string; merged: boolean }>;

  /**
   * Close a pull request without merging it (PATCH state=closed).
   */
  closePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<void>;

  /**
   * List the repositories this token's GitHub App installation can reach
   * (`GET /installation/repositories`). Requires an INSTALLATION token — a
   * user OAuth token answers 403, because the endpoint is scoped to the
   * installation the token was minted for and to no other.
   *
   * This is exactly the set `bind_main_repository` accepts: the bind resolves
   * a repository through the same installation's token, so a picker built
   * from any other list would offer options that refuse on submit.
   *
   * Walks a bounded number of pages and reports `truncated` rather than
   * paginating; see `GitHubInstallationRepositories`.
   */
  listInstallationRepositories(): Promise<GitHubInstallationRepositories>;

  /**
   * Delete a branch (DELETE /git/refs/heads/{branch}). GitHub answers 422
   * "Reference does not exist" for a branch already gone; that surfaces as
   * the thrown error.
   */
  deleteBranch(args: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<void>;
}

/** Options accepted by createGitHubClient. */
export interface GitHubClientOptions {
  /** Per-attempt timeout, including the response body. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Cancels requests and retry/polling waits, and prevents further retries. */
  signal?: AbortSignal;
  /** Refuse longer server waits instead of retrying early. Defaults to two minutes. */
  maxRateLimitWaitMs?: number;
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
