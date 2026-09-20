// repository.bound.ts — one bound repository by its binding id, and a GitHub
// client that reads it through the workspace's own App installation.
//
// Shared by the three capabilities the Repositories page added:
// `get_repository_tree`, `set_production_branch` and `open_init_pr`. Each
// names a repository by the `rpb_…` id `list_repositories` answered, so each
// needs the same two things first: the head in THIS workspace whose current
// binding carries that id, and a client minted from the installation attached
// to the workspace's live GitHub connection. The caller never names an
// installation, for the reason `bind_main_repository` gives.
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import {
  createGitHubClient,
  getInstallationToken,
  type GitHubClient,
  type GitHubRepoInfo,
} from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq } from "drizzle-orm";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";

type Scope = { orgId: string; workspaceId: string };

/** The head and the binding version it points at, as the store holds them. */
export interface BoundRepository {
  headId: string;
  role: "main" | "linked";
  connectionId: string;
  providerRepositoryId: string;
  bindingRowId: string;
  bindingId: string;
  version: number;
  owner: string;
  name: string;
  fullName: string;
  productionBranch: string;
}

/** The refusal for a binding id no head in this workspace carries. */
export function repositoryNotLinked(bindingId: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "repository_not_linked",
    message: `No repository with binding ${bindingId} is bound to this workspace`,
  });
}

/**
 * The head whose current binding carries `bindingId`, read on `tx`. RLS and
 * the explicit org and workspace predicates both bound the read, so an id
 * from another workspace is simply not found.
 */
export async function selectBoundRepository(
  tx: Tx,
  scope: Scope,
  bindingId: string,
): Promise<BoundRepository | null> {
  const [row] = await tx
    .select({
      headId: schema.repositoryBindingHeads.id,
      role: schema.repositoryBindingHeads.role,
      connectionId: schema.repositoryBindingHeads.connectionId,
      providerRepositoryId: schema.repositoryBindingHeads.providerRepositoryId,
      bindingRowId: schema.repositoryBindings.id,
      bindingId: schema.repositoryBindings.publicId,
      version: schema.repositoryBindings.version,
      owner: schema.repositoryBindings.providerOwner,
      name: schema.repositoryBindings.providerName,
      fullName: schema.repositoryBindings.providerFullName,
      productionBranch: schema.repositoryBindings.configuredDefaultRef,
    })
    .from(schema.repositoryBindingHeads)
    .innerJoin(
      schema.repositoryBindings,
      eq(
        schema.repositoryBindings.id,
        schema.repositoryBindingHeads.currentBindingId,
      ),
    )
    .where(
      and(
        eq(schema.repositoryBindingHeads.orgId, scope.orgId),
        eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindings.publicId, bindingId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    // The table's CHECK admits only these two.
    role: row.role === "main" ? "main" : "linked",
  };
}

/** The bound repository, or `not_found: repository_not_linked`. */
export async function readBoundRepository(
  scope: Scope,
  bindingId: string,
): Promise<BoundRepository> {
  const bound = await withTenantDb((tx) =>
    selectBoundRepository(tx, scope, bindingId),
  );
  if (!bound) throw repositoryNotLinked(bindingId);
  return bound;
}

/** Where a handler gets its GitHub client; the tests pass a fake. */
export interface WorkspaceGithub {
  /** A client for the workspace's installation, or null when none is attached. */
  client(scope: Scope): Promise<GitHubClient | null>;
}

export const workspaceGithub: WorkspaceGithub = {
  async client(scope) {
    const installation = await resolveWorkspaceGithubInstallation(scope);
    if (!installation) return null;
    const appId = process.env["GITHUB_APP_ID"];
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    if (!appId || !privateKey) {
      throw new Error(
        "GitHub App is not configured: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset",
      );
    }
    const { token } = await getInstallationToken({
      appId,
      privateKey,
      installationId: installation.installationId,
    });
    return createGitHubClient({ token });
  },
};

/** The client, or `conflict: github_not_connected`. */
export async function requireWorkspaceGithub(
  github: WorkspaceGithub,
  scope: Scope,
): Promise<GitHubClient> {
  const client = await github.client(scope);
  if (!client) {
    throw new HandlerError({
      code: "conflict",
      reason: "github_not_connected",
      message:
        "This workspace has no GitHub App installation attached; attach one from the Repositories page first",
    });
  }
  return client;
}

/** True when a GitHub client error is GitHub answering 404. */
export function isGithubNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("GitHub API error 404");
}

/** The refusal for a repository the installation can no longer see. */
export function repositoryNotInstalled(fullName: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "repository_not_installed",
    message: `The workspace's GitHub App installation cannot reach ${fullName}`,
  });
}

/**
 * The repository GitHub holds at this binding's coordinates, refusing when it
 * is not the repository the binding was made against.
 *
 * Owner and name are a label a person can move: delete a repository and
 * create another under the same `owner/name` and every stored coordinate
 * still resolves — to somebody else's history. The immutable id is what the
 * binding was made against, so every capability that reads or writes a bound
 * repository compares it before the first read and before any write. Without
 * this, `open_init_pr` would push governance files and open a pull request on
 * the replacement.
 */
export async function requireBoundRepoInfo(
  gh: GitHubClient,
  bound: BoundRepository,
): Promise<GitHubRepoInfo> {
  let repo: GitHubRepoInfo;
  try {
    repo = await gh.getRepoInfo({ owner: bound.owner, repo: bound.name });
  } catch (err) {
    if (isGithubNotFound(err)) throw repositoryNotInstalled(bound.fullName);
    throw err;
  }
  if (repo.id !== bound.providerRepositoryId)
    throw repositoryNotInstalled(bound.fullName);
  return repo;
}

/** Wrap a GitHub refusal as `conflict: github_refused` with GitHub's message. */
export function githubRefused(err: unknown): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "github_refused",
    message: err instanceof Error ? err.message : String(err),
  });
}
