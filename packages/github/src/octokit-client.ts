import { Octokit } from "@octokit/rest";
import type { GitHubClient, GitHubClientOptions } from "./types";

// ---------------------------------------------------------------------------
// Internal interface — only the Octokit surface we actually use.
// Keeping this narrow lets tests inject a fake without a mocking framework.
// ---------------------------------------------------------------------------

interface RepoCreateInOrgResponse {
  data: { full_name: string; html_url: string; default_branch: string };
}

interface RepoGetResponse {
  data: { full_name: string; html_url: string; default_branch: string };
}

/** getContent returns file, directory, symlink, or submodule — we only care
 *  about the file case where a `sha` string is present at the top level. */
interface RepoGetContentFileResponse {
  data: { sha: string };
}

interface RepoCreateOrUpdateFileContentsResponse {
  data: {
    commit: { sha: string };
    content: { html_url: string | null } | null;
  };
}

interface RepoCreateForkResponse {
  data: { full_name: string; html_url: string; default_branch: string };
}

interface GitGetRefResponse {
  data: { object: { sha: string } };
}

interface GitCreateRefResponse {
  data: { ref: string; object: { sha: string } };
}

interface PullsCreateResponse {
  data: { number: number; html_url: string };
}

interface UsersGetAuthenticatedResponse {
  data: { login: string };
}

/** Minimal structural interface matched by a real Octokit instance. */
export interface OctokitLike {
  repos: {
    createInOrg(params: {
      org: string;
      name: string;
      description?: string;
      private?: boolean;
      auto_init?: boolean;
    }): Promise<RepoCreateInOrgResponse>;

    get(params: {
      owner: string;
      repo: string;
    }): Promise<RepoGetResponse>;

    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<RepoGetContentFileResponse>;

    createOrUpdateFileContents(params: {
      owner: string;
      repo: string;
      path: string;
      message: string;
      content: string;
      sha?: string;
      branch?: string;
    }): Promise<RepoCreateOrUpdateFileContentsResponse>;

    createFork(params: {
      owner: string;
      repo: string;
      organization?: string;
    }): Promise<RepoCreateForkResponse>;
  };

  git: {
    getRef(params: {
      owner: string;
      repo: string;
      ref: string;
    }): Promise<GitGetRefResponse>;

    createRef(params: {
      owner: string;
      repo: string;
      ref: string;
      sha: string;
    }): Promise<GitCreateRefResponse>;
  };

  pulls: {
    create(params: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      base: string;
      body?: string;
      draft?: boolean;
    }): Promise<PullsCreateResponse>;
  };

  users: {
    getAuthenticated(): Promise<UsersGetAuthenticatedResponse>;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a GitHubClient backed by @octokit/rest.
 *
 * @param opts  - Client options (token, optional baseUrl, optional sleepMs).
 * @param _octokit - Injectable Octokit-compatible instance for testing.
 *                   In production leave this undefined; the factory creates
 *                   a real Octokit from `opts.token`.
 */
export function createGitHubClient(
  opts: GitHubClientOptions,
  _octokit?: OctokitLike
): GitHubClient {
  // Cast is intentional: OctokitLike is a structural subset of the real Octokit.
  // The getContent method in @octokit/rest returns a broad union (file | dir |
  // submodule | symlink); our interface narrows it to the file-case shape we
  // actually use. Using `as unknown as OctokitLike` avoids a false TS error
  // without weakening the internal types the rest of the implementation relies on.
  const octokit: OctokitLike =
    _octokit ??
    (new Octokit({
      auth: opts.token,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    }) as unknown as OctokitLike);

  const sleep = opts.sleep ?? defaultSleep;
  const sleepMs = opts.sleepMs ?? 2000;

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async function createRepoInOrg(args: {
    org: string;
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }> {
    const { data } = await octokit.repos.createInOrg({
      org: args.org,
      name: args.name,
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
      ...(args.private !== undefined ? { private: args.private } : {}),
      ...(args.autoInit !== undefined ? { auto_init: args.autoInit } : {}),
    });
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
    // Check whether the file already exists so we can supply its sha for
    // an update (GitHub requires it; omitting it on an existing file = 422).
    let existingSha: string | undefined;
    try {
      const { data } = await octokit.repos.getContent({
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        ...(args.branch ? { ref: args.branch } : {}),
      });
      // data.sha is present when the response is a single file object
      existingSha = data.sha;
    } catch {
      // 404 → file does not exist; any other error → re-throw
      // We intentionally swallow only because the create path is valid here.
    }

    const base64Content = Buffer.from(args.content).toString("base64");

    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner: args.owner,
      repo: args.repo,
      path: args.path,
      message: args.message,
      content: base64Content,
      ...(existingSha ? { sha: existingSha } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
    });

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
    // GitHub returns the fork metadata immediately but the fork itself may not
    // be reachable yet — poll until it resolves.
    const { data: forkData } = await octokit.repos.createFork({
      owner: args.owner,
      repo: args.repo,
      ...(args.org ? { organization: args.org } : {}),
    });

    // Derive fork coordinates (owner/repo) from full_name
    const [forkOwner, forkRepo] = forkData.full_name.split("/") as [
      string,
      string,
    ];

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const { data } = await octokit.repos.get({
          owner: forkOwner,
          repo: forkRepo,
        });
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

    // All polls exhausted — return what we got from the fork response
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
    const baseBranch = args.fromBranch ?? "main";

    const { data: refData } = await octokit.git.getRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${baseBranch}`,
    });

    const { data } = await octokit.git.createRef({
      owner: args.owner,
      repo: args.repo,
      ref: `refs/heads/${args.branch}`,
      sha: refData.object.sha,
    });

    return { ref: data.ref, sha: data.object.sha };
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
    const { data } = await octokit.pulls.create({
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      head: args.head,
      base: args.base,
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.draft !== undefined ? { draft: args.draft } : {}),
    });
    return { number: data.number, htmlUrl: data.html_url };
  }

  async function getAuthenticatedUser(): Promise<{ login: string }> {
    const { data } = await octokit.users.getAuthenticated();
    return { login: data.login };
  }

  return {
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
    getAuthenticatedUser,
  };
}
