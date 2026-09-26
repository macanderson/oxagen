/**
 * Public shapes of the gitlab.com REST v4 client. GitLab answers in
 * snake_case; the client maps every response into these camelCase shapes so
 * callers never read a raw GitLab field name.
 */

export interface GitLabClientOptions {
  token: string;
  /** Defaults to "https://gitlab.com". Only gitlab.com is supported today; the option exists for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Max retries on 429/503 with Retry-After; default 2. Sleep is injectable for tests. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A project reference: the numeric project id (preferred: survives renames and transfers) or the full path "group/sub/project". */
export type GitLabProjectRef = string | number;

export interface GitLabProject {
  /** The numeric project id as a decimal string. */
  id: string;
  pathWithNamespace: string;
  namespaceFullPath: string;
  path: string;
  defaultBranch: string | null;
  webUrl: string;
  archived: boolean;
}

export interface GitLabTokenInfo {
  id: number;
  name: string;
  scopes: string[];
  active: boolean;
  revoked: boolean;
  expiresAt: string | null;
}

export interface GitLabUser {
  id: number;
  username: string;
  /** True for the bot user GitLab creates behind a project or group access token. */
  bot: boolean;
}

export interface GitLabPathCommit {
  sha: string;
  authorName: string;
  authorEmail: string | null;
  committedAt: string;
  summary: string;
}

export interface GitLabMergeRequest {
  iid: number;
  webUrl: string;
  title: string;
  description: string;
  state: "opened" | "closed" | "locked" | "merged";
  sourceBranch: string;
  targetBranch: string;
  sha: string | null;
  mergeCommitSha: string | null;
  squashCommitSha: string | null;
  mergedAt: string | null;
  detailedMergeStatus: string | null;
  projectId: string;
}

export interface GitLabChangedPath {
  oldPath: string;
  newPath: string;
  renamed: boolean;
  deleted: boolean;
  added: boolean;
}

export type GitLabCommitAction =
  | { action: "create" | "update"; filePath: string; content: string }
  | { action: "delete"; filePath: string };

export type GitLabCommitState =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled";

export interface GitLabProjectHook {
  id: number;
  url: string;
}

export interface GitLabClient {
  /** GET /projects/:id */
  getProject(project: GitLabProjectRef): Promise<GitLabProject>;
  /** GET /personal_access_tokens/self. Project and group access tokens answer it too. */
  getCurrentToken(): Promise<GitLabTokenInfo>;
  /** GET /user */
  getCurrentUser(): Promise<GitLabUser>;
  /** Returns null when the file or the ref does not exist (404). */
  getFileRaw(a: {
    project: GitLabProjectRef;
    path: string;
    ref: string;
  }): Promise<string | null>;
  listPathCommits(a: {
    project: GitLabProjectRef;
    path: string;
    ref: string;
    limit: number;
  }): Promise<GitLabPathCommit[]>;
  /** Returns null when the branch does not exist (404). */
  getBranch(a: {
    project: GitLabProjectRef;
    branch: string;
  }): Promise<{ name: string; commitSha: string } | null>;
  /** Throws the GitLabApiError as-is, including 400 "Branch already exists". */
  createBranch(a: {
    project: GitLabProjectRef;
    branch: string;
    ref: string;
  }): Promise<void>;
  /** Throws GitLabApiError, including a 404 for a branch that does not exist. */
  deleteBranch(a: { project: GitLabProjectRef; branch: string }): Promise<void>;
  /** Every blob path under the ref, recursively, across all pages. */
  /** With `path`, only the blobs under that directory (GitLab's `path` filter). */
  listTree(a: {
    project: GitLabProjectRef;
    ref: string;
    path?: string;
  }): Promise<string[]>;
  /** POST /projects/:id/repository/commits */
  commitFiles(a: {
    project: GitLabProjectRef;
    branch: string;
    message: string;
    actions: GitLabCommitAction[];
  }): Promise<{ sha: string }>;
  /** Compares from the merge base (straight=false), like GitHub's three-dot compare. */
  compare(a: {
    project: GitLabProjectRef;
    from: string;
    to: string;
  }): Promise<GitLabChangedPath[]>;
  createMergeRequest(a: {
    project: GitLabProjectRef;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    labels?: readonly string[];
    removeSourceBranch?: boolean;
  }): Promise<GitLabMergeRequest>;
  updateMergeRequest(a: {
    project: GitLabProjectRef;
    iid: number;
    title?: string;
    description?: string;
    stateEvent?: "close" | "reopen";
  }): Promise<GitLabMergeRequest>;
  listMergeRequests(a: {
    project: GitLabProjectRef;
    sourceBranch: string;
    targetBranch: string;
    state: "opened" | "merged" | "closed" | "all";
  }): Promise<GitLabMergeRequest[]>;
  getMergeRequest(a: {
    project: GitLabProjectRef;
    iid: number;
  }): Promise<GitLabMergeRequest>;
  /** PUT .../merge with `sha` so GitLab refuses (409) when the head moved past it. */
  mergeMergeRequest(a: {
    project: GitLabProjectRef;
    iid: number;
    sha: string;
    squash: boolean;
    squashCommitMessage?: string;
    shouldRemoveSourceBranch?: boolean;
  }): Promise<GitLabMergeRequest>;
  setCommitStatus(a: {
    project: GitLabProjectRef;
    sha: string;
    state: GitLabCommitState;
    name: string;
    description?: string;
    targetUrl?: string;
  }): Promise<{ id: number; targetUrl: string | null }>;
  /** POST /projects/:id/hooks. The webhook secret `token` never appears in an error. */
  createProjectHook(a: {
    project: GitLabProjectRef;
    url: string;
    token: string;
    mergeRequestsEvents: boolean;
    pushEvents: boolean;
    /** Defaults to true. */
    enableSslVerification?: boolean;
  }): Promise<GitLabProjectHook>;
  /** DELETE /projects/:id/hooks/:hook_id. A 404 throws GitLabApiError. */
  deleteProjectHook(a: {
    project: GitLabProjectRef;
    hookId: number;
  }): Promise<void>;
}
