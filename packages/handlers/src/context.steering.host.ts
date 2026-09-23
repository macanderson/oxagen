// context.steering.host.ts — which repository host a workspace's steering
// publishes through (#3762). The workspace's main repository binding names its
// provider; this seam resolves the repository with that host and sends every
// later call on the handle to the same host.
//
// The GitHub seam keeps its legacy fallback (a sources-wizard connection with
// no binding), so a workspace with no GitLab main head goes to GitHub exactly
// as it did before GitLab existed.
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import {
  createSteeringGitHub,
  readGitHubConnection,
  type SteeringConnection,
  type SteeringHost,
  type SteeringProvider,
  type SteeringRepository,
} from "./context.steering.github";
import {
  createSteeringGitLab,
  readGitLabConnection,
} from "./context.steering.gitlab";

/**
 * The provider of the workspace's MAIN head, or null when it has none.
 *
 * Read without joining the connection on purpose: a head whose connection is
 * retired still says which host the workspace steers through, and that host's
 * own reader refuses it. Answering null there would send a GitLab workspace to
 * the GitHub seam's legacy fallback, which could resolve an unrelated GitHub
 * repository from a sources connection.
 */
export async function readMainRepositoryProvider(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<SteeringProvider | null> {
  const [head] = await withTenantDb((tx) =>
    tx
      .select({ provider: schema.repositoryBindingHeads.provider })
      .from(schema.repositoryBindingHeads)
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          eq(schema.repositoryBindingHeads.role, "main"),
        ),
      )
      .limit(1),
  );
  if (!head) return null;
  return head.provider === "gitlab" ? "gitlab" : "github";
}

/**
 * The workspace's main repository identity and approved ref, from whichever
 * host it is bound on. Readers that only need the identity (steering
 * freshness) use this instead of resolving through a host, which would call
 * the host's API. A GitLab binding answers as a `binding` source: GitLab
 * support has no legacy connection to fall back to.
 */
export async function readSteeringConnection(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<SteeringConnection | null> {
  if ((await readMainRepositoryProvider(scope)) !== "gitlab")
    return readGitHubConnection(scope);
  const connection = await readGitLabConnection(scope);
  return connection
    ? {
        source: "binding",
        owner: connection.owner,
        repo: connection.repo,
        approvedFullName: connection.approvedFullName,
        approvedDefaultRef: connection.approvedDefaultRef,
      }
    : null;
}

export interface SteeringHostDeps {
  mainProvider: typeof readMainRepositoryProvider;
  github: SteeringHost;
  gitlab: SteeringHost;
}

export function createSteeringHost(
  deps: SteeringHostDeps = {
    mainProvider: readMainRepositoryProvider,
    github: createSteeringGitHub(),
    gitlab: createSteeringGitLab(),
  },
): SteeringHost {
  const on = (repo: SteeringRepository): SteeringHost =>
    repo.provider === "gitlab" ? deps.gitlab : deps.github;
  return {
    async resolveRepository(scope) {
      const provider = await deps.mainProvider(scope);
      return (
        provider === "gitlab" ? deps.gitlab : deps.github
      ).resolveRepository(scope);
    },
    readFile: (repo, path, ref) => on(repo).readFile(repo, path, ref),
    lastCommitForPath: (repo, path, ref) =>
      on(repo).lastCommitForPath(repo, path, ref),
    ensureBranch: (repo, branch, fromBranch, options) =>
      on(repo).ensureBranch(repo, branch, fromBranch, options),
    reconcileFiles: (repo, args) => on(repo).reconcileFiles(repo, args),
    putFile: (repo, args) => on(repo).putFile(repo, args),
    openPullRequest: (repo, args) => on(repo).openPullRequest(repo, args),
    updatePullRequest: (repo, args) => on(repo).updatePullRequest(repo, args),
    findOpenPullRequest: (repo, args) =>
      on(repo).findOpenPullRequest(repo, args),
    getPullRequest: (repo, number) => on(repo).getPullRequest(repo, number),
    changedPaths: (repo, base, head) => on(repo).changedPaths(repo, base, head),
    reportCheckRun: (repo, args) => on(repo).reportCheckRun(repo, args),
    mergePullRequest: (repo, args) => on(repo).mergePullRequest(repo, args),
    closePullRequest: (repo, number) => on(repo).closePullRequest(repo, number),
    deleteBranch: (repo, branch) => on(repo).deleteBranch(repo, branch),
  };
}
