/**
 * Vendor-neutral interface for GitHub write operations.
 * Backed by @octokit/rest; swap the backing by providing a different
 * createGitHubClient implementation without changing callers.
 */
export interface GitHubClient {
  /**
   * Create a new repository inside a GitHub organisation.
   */
  createRepoInOrg(args: {
    org: string;
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
}

/** Options accepted by createGitHubClient. */
export interface GitHubClientOptions {
  /** Personal access token or GitHub App installation token. */
  token: string;
  /** Override the GitHub API base URL (e.g. for GitHub Enterprise). */
  baseUrl?: string;
  /**
   * Milliseconds to sleep between fork-polling attempts.
   * Defaults to 2000. Set to 0 in tests via the injectable `sleep` below.
   */
  sleepMs?: number;
  /**
   * Injectable sleep function — primarily for test injection.
   * Defaults to a real `setTimeout`-based implementation.
   */
  sleep?: (ms: number) => Promise<void>;
}
