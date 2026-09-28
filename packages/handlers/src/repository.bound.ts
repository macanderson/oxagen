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
//
// A steering repository the provisioner created is the one exception. Its head
// hangs from a `github_steering` connection, and only the Oxagen Steering app
// can see it. A caller that names the head's connection gets a client minted
// from that app's installation instead.
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import {
  createGitHubClient,
  getInstallationToken,
  type GitHubClient,
  type GitHubRepoInfo,
} from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import {
  GITHUB_STEERING_PROVIDER,
  mintSteeringInstallationToken,
} from "./lib/steering-app";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";

type Scope = { orgId: string; workspaceId: string };

/** The head and the binding version it points at, as the store holds them. */
export interface BoundRepository {
  headId: string;
  role: "main" | "linked";
  /** The host the binding names; the table's CHECK admits these two. */
  provider: "github" | "gitlab";
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
      provider: schema.repositoryBindingHeads.provider,
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
    // A `steering` head is the workspace's main head under its new name. It
    // maps to "main", never to "linked": `productionBranchRoles` grants a
    // workspace Owner the linked-repository write, and a steering head read
    // as linked handed them the steering repository's production branch.
    role: row.role === "linked" ? "linked" : "main",
    provider: row.provider === "gitlab" ? "gitlab" : "github",
  };
}

/**
 * The refusal for a GitLab binding reaching a capability that reads or writes
 * through a GitHub App installation (#3762). `get_repository_tree`,
 * `set_production_branch` and `open_init_pr` have no GitLab implementation
 * yet; refusing by name is better than answering `github_not_connected` for a
 * workspace that never meant to connect GitHub, or reading a GitHub repository
 * that happens to share the project's owner and name.
 */
export function repositoryHostUnsupported(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "repository_host_unsupported",
    message: `${fullName} is a GitLab project. This action supports GitHub repositories only today; Context PRs, bindings and steering publication work on GitLab.`,
  });
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
  if (bound.provider !== "github")
    throw repositoryHostUnsupported(bound.fullName);
  return bound;
}

/**
 * The installation id on a `github_steering` connection's delivery config, as
 * a positive integer, or null when it holds none. The provisioner writes a
 * number. A string of digits reads too, because the settings-path GitHub
 * connections store theirs as one. `context.steering.github.ts` holds a
 * private copy of the same rule.
 */
export function steeringInstallationIdOf(config: unknown): number | null {
  const raw =
    config !== null && typeof config === "object"
      ? (config as { installationId?: unknown }).installationId
      : undefined;
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The refusal for a `github_steering` connection with no installation id.
 * Every GitHub call would otherwise fail with a 404 that names no cause.
 */
export function steeringInstallationMissing(fullName?: string): HandlerError {
  const what = fullName
    ? `The steering repository ${fullName}`
    : "This steering repository";
  return new HandlerError({
    code: "conflict",
    reason: "steering_installation_missing",
    message: `${what} hangs from an Oxagen Steering connection with no installation id, so Oxagen cannot reach it. Provision the steering repository again.`,
  });
}

/**
 * The Oxagen Steering installation a live `github_steering` connection names,
 * or null when the connection is any other kind, retired, or not in this
 * workspace. Refuses with `conflict: steering_installation_missing` when a
 * steering connection holds no usable installation id.
 */
export async function readSteeringInstallationId(
  scope: Scope,
  connectionId: string,
): Promise<number | null> {
  const connection = schema.sourceConnections;
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        connectorId: connection.connectorId,
        deliveryConfig: connection.deliveryConfig,
      })
      .from(connection)
      .where(
        and(
          eq(connection.orgId, scope.orgId),
          eq(connection.workspaceId, scope.workspaceId),
          eq(connection.id, connectionId),
          isNull(connection.deletedAt),
          notInArray(connection.status, ["deleting", "deleted"]),
        ),
      )
      .limit(1),
  );
  if (!row || row.connectorId !== GITHUB_STEERING_PROVIDER) return null;
  const installationId = steeringInstallationIdOf(row.deliveryConfig);
  if (installationId === null) throw steeringInstallationMissing();
  return installationId;
}

/** Where a handler gets its GitHub client; the tests pass a fake. */
export interface WorkspaceGithub {
  /**
   * A client for the workspace's installation, or null when none is
   * attached. A caller that names a head's `connectionId` gets the Oxagen
   * Steering installation's client when that connection is `github_steering`.
   */
  client(scope: Scope, connectionId?: string): Promise<GitHubClient | null>;
}

export const workspaceGithub: WorkspaceGithub = {
  async client(scope, connectionId) {
    // The steering connection comes first. A workspace whose only repository
    // is its provisioned steering repository has no installation of its own,
    // and the workspace read below would answer null for it.
    if (connectionId !== undefined) {
      const steering = await readSteeringInstallationId(scope, connectionId);
      if (steering !== null) {
        const token = await mintSteeringInstallationToken(steering);
        return createGitHubClient({ token });
      }
    }
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

/**
 * The client, or `conflict: github_not_connected`. Pass the bound head's
 * `connectionId` so a steering repository reads through its own app.
 */
export async function requireWorkspaceGithub(
  github: WorkspaceGithub,
  scope: Scope,
  connectionId?: string,
): Promise<GitHubClient> {
  const client = await github.client(scope, connectionId);
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
