// context.steering.github.ts — the GitHub seam under the Context PR handlers
// (ADR-061; MC spec §10.1, §10.3). The workspace's repository is its **main
// repository**: the repository binding `bind_main_repository` wrote
// (`ingestion.repository_binding_heads` → `ingestion.repository_bindings`),
// which is the system of record for repository identity per MC spec §10.1.
// Its production branch is the default ref that binding recorded — the one an
// org owner approved — not whatever GitHub reports as the default branch
// today. Every operation runs with the workspace's own token (ADR-020:
// installation token, then the connecting user's OAuth token, then the
// local-only PAT).
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { createGitHubClient, type GitHubClient } from "@oxagen/github";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { resolveGitHubToken } from "./lib/github-token";

export interface SteeringRepository {
  owner: string;
  repo: string;
  fullName: string;
  /**
   * The production branch: the only ref a Context PR is opened against,
   * compared against, checked on and merged into.
   *
   * For a BOUND repository this is the binding's `configured_default_ref` —
   * the ref approved when `bind_main_repository` recorded that binding version
   * — and NOT whatever GitHub currently reports as the repository's default
   * branch. Changing the default branch on GitHub must not move steering onto
   * a branch nobody approved; only a new binding version does that. See
   * `readGitHubConnection`, which is the one source of this fact.
   */
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
  /** The open PR from the branch `head` into `base`, with its body, or null. */
  findOpenPullRequest(
    repo: SteeringRepository,
    args: { head: string; base: string },
  ): Promise<{ number: number; htmlUrl: string; body: string } | null>;
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

/**
 * Statuses that mean the connection is on its way out. `delete_connection`
 * sets `status = 'deleting'` and leaves `deleted_at` for a later purge, so
 * `deleted_at IS NULL` alone does not mean live — the same rule
 * `resolveWorkspaceGithubInstallation` applies before it mints a token.
 * Duplicated rather than imported because that resolver is the installation
 * seam and this is the repository-identity seam; they share the rule, not a
 * dependency.
 */
const RETIRED_CONNECTION_STATUSES = ["deleting", "deleted"] as const;

/**
 * Where the workspace's main repository came from, and therefore whether it
 * carries an approved production ref. `readGitHubConnection` answers one of
 * these; the two cases are a union rather than one shape with an optional ref
 * because they are not the same fact, and only the type can stop a reader
 * treating them as one.
 */
export type SteeringConnection =
  | {
      /**
       * A binding answered. `approvedDefaultRef` is that binding's
       * `configured_default_ref` and moves only when a new binding version is
       * written — never because GitHub's default branch changed.
       */
      source: "binding";
      owner: string;
      repo: string;
      approvedDefaultRef: string;
    }
  | {
      /**
       * The legacy sources wizard's `delivery_config`, which predates bindings
       * and records no ref. The absence is its own case rather than a nullable
       * `approvedDefaultRef` so that reading the ref forces a reader to narrow
       * on `source` and see both arms: an optional field would let the bound
       * case fall through to live GitHub with a `??` that looks like a default
       * and is in fact the defect this shape exists to prevent.
       */
      source: "legacy_delivery_config";
      owner: string;
      repo: string;
    };

/**
 * The workspace's main repository.
 *
 * Read from the repository binding first. `repository_bindings` exists
 * precisely because `source_connections.delivery_config` is a mutable JSONB
 * bag whose `owner`/`repo` keys mean *the ingestion sync target* to every
 * other reader of that column — `ingestion.sync-requested` dispatches a full
 * tree sync at them, and `reference.search` lists them as searchable repos.
 * The main repository is a different fact, and writing it into that bag would
 * silently retarget a legacy wizard connection's sync. So identity comes from
 * the binding, keyed on the provider's immutable repository id, which is what
 * MC spec §10.1 makes the system of record.
 *
 * The binding is joined back to its connection so that revoking the GitHub
 * connection stops steering from the moment of the revoke, not from whenever
 * the purge catches up — the binding rows outlive the connection.
 *
 * Falls back to the connection's delivery config for a workspace connected
 * through the legacy sources wizard, which populates `owner`/`repo` at its
 * mappings step and never writes a binding. Without the fallback those
 * workspaces would lose steering; with it, a workspace that later binds a main
 * repository is answered from the binding, which wins.
 *
 * The fallback is narrowed to the case it exists for: NO BINDING HEAD AT ALL.
 * The joined read above misses for two different reasons — no head was ever
 * written, or a head exists and the connection it was bound through is
 * retired — and they are not the same fact. Falling back on the second one
 * silently retargets steering and every Context PR at whatever unrelated
 * repository a still-connected legacy sources connection happens to name in
 * its ingestion `delivery_config`. Writing steering into the wrong repository
 * is worse than steering being off, so a workspace whose main repository is
 * bound but unreachable answers null and its callers refuse; the repair is
 * `bind_main_repository` on the live connection, which moves the head.
 *
 * The binding also carries the ref, not only the identity. A binding records
 * `configured_default_ref` — the production branch as it stood when an org
 * owner approved that binding version — and the binding is immutable, so a
 * later change to the repository's default branch on GitHub does not touch it.
 * Returning identity here while leaving the ref to resolve from a live
 * `getRepoInfo` would make the binding authoritative for half of one fact:
 * steering would keep the approved owner/name and silently follow GitHub onto
 * a branch nobody approved. So the ref is returned with the identity that
 * carries it, and it is the caller's only source for the bound case.
 */
export async function readGitHubConnection(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<SteeringConnection | null> {
  return withTenantDb(async (tx) => {
    const [bound] = await tx
      .select({
        owner: schema.repositoryBindings.providerOwner,
        repo: schema.repositoryBindings.providerName,
        approvedDefaultRef: schema.repositoryBindings.configuredDefaultRef,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .innerJoin(
        schema.sourceConnections,
        eq(
          schema.sourceConnections.id,
          schema.repositoryBindingHeads.connectionId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          // Only the MAIN repository steers. `role` is 'main' for every head
          // the binder writes, and 'linked' only for one the exclusivity
          // migration demoted because an older head already claimed the
          // repository. A reader that ignores the column goes on resolving
          // through a demoted head, so the cross-workspace steering collision
          // the index forbids would survive the reconciliation that was meant
          // to end it.
          eq(schema.repositoryBindingHeads.role, "main"),
          eq(schema.repositoryBindingHeads.provider, "github"),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, [
            ...RETIRED_CONNECTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    if (bound)
      return {
        source: "binding",
        owner: bound.owner,
        repo: bound.repo,
        approvedDefaultRef: bound.approvedDefaultRef,
      };

    // Why the join missed. A head is the workspace's declaration that it HAS a
    // main repository; its presence survives the connection being retired,
    // which is exactly the state the join cannot tell apart from "never bound".
    const [head] = await tx
      .select({ id: schema.repositoryBindingHeads.id })
      .from(schema.repositoryBindingHeads)
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          eq(schema.repositoryBindingHeads.provider, "github"),
        ),
      )
      .limit(1);
    if (head) return null;

    const [connection] = await tx
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
      .limit(1);
    const config = (connection?.deliveryConfig as DeliveryConfig | null) ?? {};
    const owner = typeof config.owner === "string" ? config.owner : null;
    const repo = typeof config.repo === "string" ? config.repo : null;
    return connection && owner && repo
      ? { source: "legacy_delivery_config", owner, repo }
      : null;
  });
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
      const info = await gh.getRepoInfo({
        owner: connection.owner,
        repo: connection.repo,
      });
      // Where the production branch comes from, stated as two arms rather than
      // as a fallback, because they are two different facts.
      //
      // A BOUND repository has an approved ref and that ref is the answer. The
      // live `info.defaultBranch` is deliberately not consulted here: if an
      // admin changes the repository's default branch on GitHub after the
      // bind, the immutable binding and the settings page still name the
      // approved branch, and steering must agree with them. Following GitHub
      // instead would open, check and merge Context PRs into a branch no one
      // approved, while `assertProductionBase` below — which compares a PR's
      // base against this very field — would wave it through. Approving a new
      // branch is a new binding version (`bind_main_repository`), which is the
      // only thing that moves this.
      //
      // A LEGACY connection has no binding, so there is no approved ref to
      // honour and live GitHub is the only source there is. That is
      // legitimate precisely because nothing was ever approved to disagree
      // with — it is not the bound case taking a fallback, which the union's
      // shape makes unreachable.
      const defaultBranch =
        connection.source === "binding"
          ? connection.approvedDefaultRef
          : info.defaultBranch;
      const repo: SteeringRepository = {
        owner: connection.owner,
        repo: connection.repo,
        fullName: info.fullName,
        defaultBranch,
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
