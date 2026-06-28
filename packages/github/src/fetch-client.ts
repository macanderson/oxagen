import type { GitHubClient, GitHubClientOptions } from "./types";

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_SLEEP_MS = 1500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

  async function createRepoInOrg(args: {
    org: string;
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }> {
    const body: Record<string, unknown> = { name: args.name };
    if (args.description !== undefined) body.description = args.description;
    if (args.private !== undefined) body.private = args.private;
    if (args.autoInit !== undefined) body.auto_init = args.autoInit;

    const data = await request<GHRepo>("POST", `/orgs/${args.org}/repos`, body);
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
    const refQuery = args.branch ? `?ref=${encodeURIComponent(args.branch)}` : "";
    try {
      const existing = await request<GHFileContent>(
        "GET",
        `/repos/${args.owner}/${args.repo}/contents/${args.path}${refQuery}`,
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

    const data = await request<GHPutFileResponse>(
      "PUT",
      `/repos/${args.owner}/${args.repo}/contents/${args.path}`,
      putBody,
    );

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
      `/repos/${args.owner}/${args.repo}/forks`,
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
          `/repos/${forkOwner}/${forkRepoName}`,
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
    // When fromBranch is not provided, fetch the repo to discover default_branch.
    let baseBranch = args.fromBranch;
    if (!baseBranch) {
      const repo = await request<GHRepo>(
        "GET",
        `/repos/${args.owner}/${args.repo}`,
      );
      baseBranch = repo.default_branch;
    }

    const refData = await request<GHRef>(
      "GET",
      `/repos/${args.owner}/${args.repo}/git/ref/heads/${baseBranch}`,
    );

    const newRef = await request<GHRef>(
      "POST",
      `/repos/${args.owner}/${args.repo}/git/refs`,
      { ref: `refs/heads/${args.branch}`, sha: refData.object.sha },
    );

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
      `/repos/${args.owner}/${args.repo}/pulls`,
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
        `/repos/${args.owner}/${args.repo}/contents/${args.path}${refQuery}`,
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
    // Step 1 — resolve branch → tree SHA via the branches endpoint.
    const branch = await request<GHBranch>(
      "GET",
      `/repos/${args.owner}/${args.repo}/branches/${encodeURIComponent(ref)}`,
    );
    const treeSha = branch.commit.commit.tree.sha;
    // Step 2 — fetch the recursive tree.
    const treeData = await request<GHTreeResponse>(
      "GET",
      `/repos/${args.owner}/${args.repo}/git/trees/${treeSha}?recursive=1`,
    );
    return treeData.tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path);
  }

  return {
    getAuthenticatedUser,
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
    getFileContent,
    getTree,
  };
}
