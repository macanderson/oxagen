// context.steering.github.ts — the GitHub seam under the Context PR handlers
// (ADR-061; MC spec §10.1, §10.3). The workspace's repository is the one its
// GitHub source connection names (`source_connections.delivery_config.owner`
// and `.repo`, connector `github`, status `connected`); its production branch
// is the repository's default branch. Every operation runs with the
// workspace's own token (ADR-020: installation token, then the connecting
// user's OAuth token, then the local-only PAT).
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { createGitHubClient, type GitHubClient } from "@oxagen/github";
import { and, eq, isNull } from "drizzle-orm";
import { resolveGitHubToken } from "./lib/github-token";

export interface SteeringRepository {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

export interface SteeringGitHub {
  resolveRepository(scope: {
    orgId: string;
    workspaceId: string;
  }): Promise<SteeringRepository>;
  readFile(
    repo: SteeringRepository,
    path: string,
    ref: string,
  ): Promise<string | null>;
  /** Create the branch from `fromBranch`; an existing branch is reused. */
  ensureBranch(
    repo: SteeringRepository,
    branch: string,
    fromBranch: string,
  ): Promise<void>;
  putFile(
    repo: SteeringRepository,
    args: { path: string; content: string; message: string; branch: string },
  ): Promise<{ commitSha: string }>;
  openPullRequest(
    repo: SteeringRepository,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; htmlUrl: string }>;
  /** The open PR from the branch `head` into `base`, or null. */
  findOpenPullRequest(
    repo: SteeringRepository,
    args: { head: string; base: string },
  ): Promise<{ number: number; htmlUrl: string } | null>;
  /** The branch the PR merges into, its head commit and, once GitHub merged it, the merge commit. */
  getPullRequest(
    repo: SteeringRepository,
    number: number,
  ): Promise<{
    baseRef: string;
    headSha: string | null;
    merged: boolean;
    mergeCommitSha: string | null;
  }>;
  /**
   * Every path the commit `head` changes against `base`, as its pull request
   * shows them; a rename names both its paths.
   */
  changedPaths(
    repo: SteeringRepository,
    base: string,
    head: string,
  ): Promise<string[]>;
  /** The check run's URL, or null when GitHub refuses the token (not an App). */
  reportCheckRun(
    repo: SteeringRepository,
    args: {
      name: string;
      headSha: string;
      conclusion: "success" | "failure";
      title: string;
      summary: string;
      startedAt: string;
      completedAt: string;
    },
  ): Promise<string | null>;
  /** Squash-merge, pinned to `sha`: GitHub refuses when the head moved past it. */
  mergePullRequest(
    repo: SteeringRepository,
    args: { number: number; commitTitle: string; sha: string },
  ): Promise<{ sha: string }>;
  closePullRequest(repo: SteeringRepository, number: number): Promise<void>;
  /** Delete the branch; a branch already gone is not an error. */
  deleteBranch(repo: SteeringRepository, branch: string): Promise<void>;
}

interface DeliveryConfig {
  owner?: unknown;
  repo?: unknown;
}

/** The workspace's connected GitHub repository, from its source connection. */
async function readGitHubConnection(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<{ owner: string; repo: string } | null> {
  const [connection] = await withTenantDb((tx) =>
    tx
      .select({ deliveryConfig: schema.sourceConnections.deliveryConfig })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.connectorId, "github"),
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );
  const config = (connection?.deliveryConfig as DeliveryConfig | null) ?? {};
  const owner = typeof config.owner === "string" ? config.owner : null;
  const repo = typeof config.repo === "string" ? config.repo : null;
  return connection && owner && repo ? { owner, repo } : null;
}

/** What the seam is built from; the tests pass fakes. */
interface SteeringGitHubDeps {
  readConnection: typeof readGitHubConnection;
  resolveToken: (scope: {
    orgId: string;
    workspaceId: string;
  }) => Promise<string>;
  client: (token: string) => GitHubClient;
}

/**
 * A Context PR merges only into the production branch. GitHub lets anyone
 * with write access retarget a PR, so its base is read back before the checks
 * run and before the merge.
 */
export function assertProductionBase(
  repo: SteeringRepository,
  baseRef: string,
  prUrl: string | null,
): void {
  if (baseRef !== repo.defaultBranch) {
    throw new HandlerError({
      code: "conflict",
      reason: "base_moved",
      message: `${prUrl ?? "The pull request"} targets ${baseRef}; a Context PR merges only into ${repo.defaultBranch}`,
    });
  }
}

/** Wrap a GitHub error as a `conflict` the surfaces map to 409. */
function githubRefused(err: unknown): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "github_refused",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function createSteeringGitHub(
  deps: SteeringGitHubDeps = {
    readConnection: readGitHubConnection,
    resolveToken: resolveGitHubToken,
    client: (token) => createGitHubClient({ token }),
  },
): SteeringGitHub {
  // Keyed by the handle `resolveRepository` returned, so a client built with
  // one workspace's token serves only the calls made with that workspace's
  // handle; two workspaces connected to one repository never share an entry.
  const clients = new WeakMap<SteeringRepository, GitHubClient>();
  const clientFor = (repo: SteeringRepository): GitHubClient => {
    const gh = clients.get(repo);
    if (!gh)
      throw new Error(`[context.steering] no client for ${repo.fullName}`);
    return gh;
  };
  return {
    async resolveRepository(scope) {
      const connection = await deps.readConnection(scope);
      if (!connection) {
        throw new HandlerError({
          code: "not_found",
          reason: "workspace_repository_missing",
          message:
            "This workspace has no connected GitHub repository; a Context PR needs the main repo (MC spec §10.1)",
        });
      }
      const gh = deps.client(await deps.resolveToken(scope));
      const info = await gh.getRepoInfo(connection);
      const repo: SteeringRepository = {
        owner: connection.owner,
        repo: connection.repo,
        fullName: info.fullName,
        defaultBranch: info.defaultBranch,
      };
      clients.set(repo, gh);
      return repo;
    },
    async readFile(repo, path, ref) {
      return clientFor(repo).getFileContent({
        owner: repo.owner,
        repo: repo.repo,
        path,
        ref,
      });
    },
    async ensureBranch(repo, branch, fromBranch) {
      try {
        await clientFor(repo).createBranch({
          owner: repo.owner,
          repo: repo.repo,
          branch,
          fromBranch,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          /Reference already exists/i.test(err.message)
        )
          return;
        throw githubRefused(err);
      }
    },
    async putFile(repo, args) {
      try {
        const out = await clientFor(repo).putFile({
          owner: repo.owner,
          repo: repo.repo,
          ...args,
        });
        return { commitSha: out.commitSha };
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async openPullRequest(repo, args) {
      try {
        return await clientFor(repo).openPullRequest({
          owner: repo.owner,
          repo: repo.repo,
          ...args,
        });
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async findOpenPullRequest(repo, args) {
      try {
        return await clientFor(repo).findOpenPullRequest({
          owner: repo.owner,
          repo: repo.repo,
          ...args,
        });
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async changedPaths(repo, base, head) {
      try {
        const files = await clientFor(repo).compareCommits({
          owner: repo.owner,
          repo: repo.repo,
          base,
          head,
        });
        return [
          ...new Set(
            files.flatMap((f) =>
              f.previousPath ? [f.previousPath, f.path] : [f.path],
            ),
          ),
        ];
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async getPullRequest(repo, number) {
      try {
        const pr = await clientFor(repo).getPullRequest({
          owner: repo.owner,
          repo: repo.repo,
          number,
        });
        return {
          baseRef: pr.baseRef,
          headSha: pr.headSha,
          merged: pr.merged,
          mergeCommitSha: pr.mergeCommitSha,
        };
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async reportCheckRun(repo, args) {
      try {
        const out = await clientFor(repo).createCheckRun({
          owner: repo.owner,
          repo: repo.repo,
          ...args,
        });
        return out.htmlUrl;
      } catch (err) {
        // A token without checks:write (OAuth, PAT) is refused with 403; the
        // check's outcome is recorded on the proposal either way, and the
        // merge gate reads the proposal.
        if (err instanceof Error && /GitHub API error 403/.test(err.message))
          return null;
        throw githubRefused(err);
      }
    },
    async mergePullRequest(repo, args) {
      try {
        const out = await clientFor(repo).mergePullRequest({
          owner: repo.owner,
          repo: repo.repo,
          number: args.number,
          mergeMethod: "squash",
          commitTitle: args.commitTitle,
          sha: args.sha,
        });
        return { sha: out.sha };
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async closePullRequest(repo, number) {
      try {
        await clientFor(repo).closePullRequest({
          owner: repo.owner,
          repo: repo.repo,
          number,
        });
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async deleteBranch(repo, branch) {
      try {
        await clientFor(repo).deleteBranch({
          owner: repo.owner,
          repo: repo.repo,
          branch,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          /Reference does not exist/i.test(err.message)
        )
          return;
        throw githubRefused(err);
      }
    },
  };
}
