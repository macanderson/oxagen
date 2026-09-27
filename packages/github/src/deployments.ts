// deployments.ts: the GitHub REST calls the steering merge queue needs and
// `GitHubClient` does not carry (#4449). A steering publish is recorded as a
// deployment to the `steering` environment, so a repository's Deployments
// page lists every version Oxagen published and the commit it came from.
//
// `githubRest` is the plain request underneath. The steering host also sends
// its git-data calls through it (a stamp commit, a branch update, a reset, a
// squash merge with a commit message, the PR's reviews), because those are
// steering's alone and do not belong on the shared client.
import { GitHubApiError } from "./fetch-client";

const DEFAULT_BASE_URL = "https://api.github.com";

export interface GitHubRestOptions {
  /** A GitHub App installation token, an OAuth token, or a personal token. */
  token: string;
  /** Override the API base URL (GitHub Enterprise). */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout, including the response body. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** A 2xx answer: its status, because 201 and 204 can mean different things. */
export interface GitHubRestResponse<T> {
  status: number;
  data: T;
}

export interface GitHubRest {
  /**
   * Send one request under the API base URL. A non-2xx answer throws
   * `GitHubApiError` with GitHub's own message and the status as a field.
   * There is no retry: every caller is inside a merge that can be run again.
   */
  request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitHubRestResponse<T>>;
}

export function githubRest(opts: GitHubRestOptions): GitHubRest {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) {
        if (res.status === 204)
          return { status: 204, data: undefined as T };
        return { status: res.status, data: (await res.json()) as T };
      }
      // GitHub puts the reason in `message`. An unreadable body still has a
      // status line worth reporting.
      const err = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new GitHubApiError(res.status, err?.message || res.statusText);
    },
  };
}

/** One path segment, encoded. A branch name keeps its slashes. */
export function githubPath(...segments: string[]): string {
  return segments
    .map((s) => s.split("/").map(encodeURIComponent).join("/"))
    .join("/");
}

export interface SteeringDeploymentInput {
  owner: string;
  repo: string;
  /** The commit the publish landed as: the squash merge on the production branch. */
  sha: string;
  environment: string;
  description: string;
}

export interface SteeringDeployment {
  id: number;
  /** The repository's page for the environment, where the deployment is listed. */
  url: string | null;
}

interface GHDeployment {
  id: number;
}

/**
 * Record a steering publish as a successful deployment of `sha` to
 * `environment`.
 *
 * `required_contexts: []` because the publish already passed the one check a
 * steering PR has, and GitHub would otherwise refuse a deployment whose
 * commit lacks every status the repository requires. `auto_merge: false`
 * because GitHub's default merges the default branch into the ref first, and
 * a publish names one commit, not whatever the branch holds a moment later.
 */
export async function recordSteeringDeployment(
  rest: GitHubRest,
  input: SteeringDeploymentInput,
): Promise<SteeringDeployment> {
  const repoPath = `/repos/${githubPath(input.owner)}/${githubPath(input.repo)}`;
  const created = await rest.request<GHDeployment & { message?: string }>(
    "POST",
    `${repoPath}/deployments`,
    {
      ref: input.sha,
      environment: input.environment,
      description: input.description,
      auto_merge: false,
      required_contexts: [],
    },
  );
  // 202 means GitHub started a merge instead of creating the deployment,
  // which `auto_merge: false` rules out; it is refused rather than guessed at.
  if (created.status !== 201 || typeof created.data?.id !== "number")
    throw new GitHubApiError(
      created.status,
      created.data?.message ?? "GitHub did not create the deployment",
    );
  await rest.request("POST", `${repoPath}/deployments/${created.data.id}/statuses`, {
    state: "success",
    description: input.description,
    auto_inactive: true,
  });
  return {
    id: created.data.id,
    url: `https://github.com/${githubPath(input.owner)}/${githubPath(input.repo)}/deployments/${encodeURIComponent(input.environment)}`,
  };
}
