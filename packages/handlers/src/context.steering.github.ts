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
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubPathCommit,
} from "@oxagen/github";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { logger } from "./logger";
import { resolveGitHubToken } from "./lib/github-token";

/**
 * The repository hosts steering can publish through. A Context PR on GitHub is
 * a pull request; on GitLab it is a merge request. The two share this port and
 * nothing else: identifiers, credentials and check semantics stay with each
 * host's implementation.
 */
export type SteeringProvider = "github" | "gitlab";

/**
 * The workspace's main repository as one host resolved it. `provider` says
 * which implementation owns every later call made with this handle, so a
 * handle a GitHub resolve produced is never answered by GitLab.
 */
export type SteeringRepository = SteeringRepositoryFields &
  (
    | { provider: "github" }
    | {
        provider: "gitlab";
        /**
         * GitLab's numeric project id, as the binding recorded it. Every call
         * addresses the project by this id rather than by path, because a
         * project that moves to another group keeps its id and changes its
         * path.
         */
        projectId: string;
      }
  );

interface SteeringRepositoryFields {
  /**
   * The owner as the host names it. On GitLab this is the full namespace
   * path, so a project in a nested group has an owner such as
   * `acme/platform/tools`.
   */
  owner: string;
  repo: string;
  /**
   * `owner/name` as the BINDING recorded it — an identifier, not a label.
   *
   * `open_context_pr` dots this into the `set_id` at the top of every Context
   * record file and stores it as the proposal row's `repository`, so it is
   * what groups a workspace's records into one set. Taking it from live
   * GitHub meant a repository rename silently re-stamped every subsequent
   * record with a different set id while the existing ones kept the old one:
   * two sets, no error, nothing said. It moves only when a new binding
   * version is written, exactly like `defaultBranch`.
   *
   * For a LEGACY connection there is no binding and so nothing approved to
   * freeze; the live value is the only one there is. Same reasoning as
   * `defaultBranch` below.
   */
  fullName: string;
  /**
   * `owner/name` as GitHub reports it RIGHT NOW — a label, never an
   * identifier.
   *
   * Equal to `fullName` until someone renames the repository, and the whole
   * point of keeping it is that the two can differ: a difference means the
   * repository has been renamed since it was bound, which is worth saying out
   * loud rather than discovering from records that no longer match their repo.
   * `resolveRepository` logs it, and it is what diagnostics name, because when
   * a GitHub call fails the useful name is the one GitHub would answer to.
   *
   * Never put this in a `set_id`, a stored key, or anything else that has to
   * mean the same thing next month.
   */
  currentFullName: string;
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

/**
 * The port every steering handler publishes through (ADR-061). The method
 * names are GitHub's because GitHub was the first host; a GitLab
 * implementation answers the same calls with merge requests, commit statuses
 * and project access tokens (#3762). `createSteeringHost` picks the host from
 * the workspace's main repository binding.
 */
export interface SteeringHost {
  resolveRepository(scope: {
    orgId: string;
    workspaceId: string;
  }): Promise<SteeringRepository>;
  readFile(
    repo: SteeringRepository,
    path: string,
    ref: string,
  ): Promise<string | null>;
  /**
   * The commit that last touched `path` on `ref`, or null when nothing on that
   * ref has ever touched it.
   *
   * This is a published record's provenance. A record is in force because its
   * commit merged into the production branch, so who published it and when are
   * facts about that commit — read back from git every time, never copied into
   * a column that a later edit can leave stale.
   */
  lastCommitForPath(
    repo: SteeringRepository,
    path: string,
    ref: string,
  ): Promise<GitHubPathCommit | null>;
  /** Create the branch from `fromBranch`; an existing branch is reused. */
  ensureBranch(
    repo: SteeringRepository,
    branch: string,
    fromBranch: string,
    options?: { exclusive: boolean },
  ): Promise<void>;
  /** Remove omitted files from a proposal's owned paths before writing its replacement. */
  reconcileFiles(
    repo: SteeringRepository,
    args: { branch: string; roots: string[]; files: string[] },
  ): Promise<void>;
  putFile(
    repo: SteeringRepository,
    args: { path: string; content: string; message: string; branch: string },
  ): Promise<{ commitSha: string }>;
  openPullRequest(
    repo: SteeringRepository,
    args: {
      title: string;
      head: string;
      base: string;
      body: string;
      labels?: readonly string[];
    },
  ): Promise<{ number: number; htmlUrl: string }>;
  updatePullRequest(
    repo: SteeringRepository,
    args: { number: number; title: string; body: string },
  ): Promise<{ number: number; htmlUrl: string }>;
  /** The open PR from the branch `head` into `base`, with its body, or null. */
  findOpenPullRequest(
    repo: SteeringRepository,
    args: { head: string; base: string },
  ): Promise<{ number: number; htmlUrl: string; body: string } | null>;
  /**
   * The branch the PR merges into, its head commit and, once GitHub merged
   * it, the merge commit and the instant GitHub merged it. That instant is
   * what a resumed publication is stamped with: it is the order the commits
   * landed on the production branch, which the time of a retry is not.
   */
  getPullRequest(
    repo: SteeringRepository,
    number: number,
  ): Promise<{
    baseRef: string;
    headSha: string | null;
    merged: boolean;
    mergeCommitSha: string | null;
    mergedAt: Date | null;
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
  /**
   * Report one check on the head commit: a check run on GitHub, a commit
   * status on GitLab. Answers the check's URL, or null when the host refuses
   * the token (a GitHub token that is not an App) or has no page for it.
   */
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
  /** Squash-merge, pinned to `sha`: the host refuses when the head moved past it. */
  mergePullRequest(
    repo: SteeringRepository,
    args: { number: number; commitTitle: string; sha: string },
  ): Promise<{ sha: string }>;
  closePullRequest(repo: SteeringRepository, number: number): Promise<void>;
  /** Delete the branch; a branch already gone is not an error. */
  deleteBranch(repo: SteeringRepository, branch: string): Promise<void>;
}

/** The GitHub implementation of {@link SteeringHost}. */
export type SteeringGitHub = SteeringHost;

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
      /**
       * That binding's `provider_full_name` — `owner/name` as it was when the
       * binding version was written. Like `approvedDefaultRef` it moves only
       * on a new binding version, never because the repository was renamed on
       * GitHub, because it is dotted into the `set_id` every Context record
       * file carries and that id has to keep naming one set.
       */
      approvedFullName: string;
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
        approvedFullName: schema.repositoryBindings.providerFullName,
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
        approvedFullName: bound.approvedFullName,
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
          // Only a MAIN head declares a main repository. A linked head
          // (`link_repository`) declares nothing about steering, and counting
          // it would report "bound but retired" for a workspace whose linked
          // repository is all it has.
          eq(schema.repositoryBindingHeads.role, "main"),
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

/**
 * A Context PR that GitHub merged at a commit the checks never ran on.
 *
 * Someone merged it on the host instead of from Oxagen, after the head moved:
 * a merge of `main` into the branch, or a review bot's suggestion accepted
 * into the record file. Oxagen publishes only the commit its checks passed
 * on, so this merge published nothing to the registry, and the record file
 * now on the production branch may not verify. Re-running the checks cannot
 * fix it, because the pull request is closed and its head can no longer
 * change. The way out is to dismiss this proposal and propose the wording
 * again in Oxagen, which writes a freshly stamped file in a new Context PR.
 */
export function mergedOutsideOxagen(
  prUrl: string | null,
  mergedHead: string | null,
  checkedHead: string | null,
): HandlerError {
  const at = mergedHead ? ` at ${mergedHead}` : "";
  const checked = checkedHead
    ? `, and the checks ran on ${checkedHead}`
    : ", and the checks never passed on it";
  return new HandlerError({
    code: "conflict",
    reason: "merged_outside_oxagen",
    message: `Someone merged ${prUrl ?? "this pull request"} on the repository host${at}${checked}, so Oxagen published nothing. Dismiss this proposal, then propose the wording you want in Oxagen and merge that Context PR from Oxagen.`,
  });
}

/**
 * A proposal's PR number is read back only through the host that issued it.
 *
 * A GitHub PR number and a GitLab merge request IID are both small integers
 * scoped to one repository. If the workspace's main repository moved to the
 * other host after the PR opened, the recorded number names an unrelated
 * pull request or merge request there, so every read, merge and close
 * through it is refused. `provider` is the proposal row's; a row written
 * before the column existed was opened on GitHub.
 */
export function assertSameHost(
  repo: SteeringRepository,
  provider: string | null,
  prUrl: string | null,
): void {
  const opened = provider ?? "github";
  if (opened !== repo.provider) {
    throw new HandlerError({
      code: "conflict",
      reason: "repository_host_changed",
      message: `${prUrl ?? "The pull request"} was opened on ${opened}, but this workspace's main repository is now on ${repo.provider}. Dismiss the proposal and propose it again.`,
    });
  }
}

/**
 * Wrap a GitHub refusal as `conflict: github_refused` with GitHub's own
 * message. A `HandlerError` passes through unchanged, so a refusal this
 * module already shaped (`proposal_branch_exists`, a missing binding) keeps
 * its reason when a caller wraps a whole GitHub sequence in one try.
 */
export function githubRefused(err: unknown): HandlerError {
  if (err instanceof HandlerError) return err;
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
      // The APPROVED name, not the current one. This fires on a handle that
      // did not come from `resolveRepository` — which is the one thing that
      // sets `currentFullName` — so naming it here prints `undefined` exactly
      // when the message matters. The identifier is always present.
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
      // The same argument as the ref, one field over. `fullName` is dotted
      // into the `set_id` of every Context record file and stored as the
      // proposal row's `repository`, so it is an IDENTIFIER: taking it from
      // live GitHub meant a rename re-stamped every later record with a new
      // set id while the existing ones kept the old one — two sets for one
      // workspace, silently. The binding froze the name for exactly this, and
      // `get_main_repository` already answers the frozen one, so live GitHub
      // here also disagreed with the settings page.
      const fullName =
        connection.source === "binding"
          ? connection.approvedFullName
          : info.fullName;
      if (fullName !== info.fullName) {
        // Said out loud rather than absorbed. The two differing means the
        // repository was renamed after it was bound; records stay correctly
        // grouped under the approved name, but an operator comparing a record
        // to GitHub sees two names and no explanation unless something logs
        // it. Re-approving through `bind_main_repository` writes the new name
        // into a successor binding and ends the divergence.
        logger.warn(
          {
            approvedFullName: fullName,
            currentFullName: info.fullName,
            owner: connection.owner,
            repo: connection.repo,
          },
          "context.steering: the repository was renamed since it was bound; records stay stamped with the approved name",
        );
      }
      const repo: SteeringRepository = {
        provider: "github",
        owner: connection.owner,
        repo: connection.repo,
        fullName,
        currentFullName: info.fullName,
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
    async lastCommitForPath(repo, path, ref) {
      const [commit] = await clientFor(repo).listPathCommits({
        owner: repo.owner,
        repo: repo.repo,
        path,
        ref,
        limit: 1,
      });
      return commit ?? null;
    },
    async ensureBranch(repo, branch, fromBranch, options) {
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
        ) {
          if (options?.exclusive)
            throw new HandlerError({
              code: "conflict",
              reason: "proposal_branch_exists",
              message:
                "The proposal branch already exists without a matching open proposal. Preserve or remove it explicitly before retrying.",
            });
          return;
        }
        throw githubRefused(err);
      }
    },
    async reconcileFiles(repo, args) {
      try {
        const gh = clientFor(repo);
        const paths = await gh.getTree({
          owner: repo.owner,
          repo: repo.repo,
          ref: args.branch,
        });
        for (const path of paths) {
          if (
            args.roots.some(
              (root) => path === root || path.startsWith(`${root}/`),
            ) &&
            !args.files.includes(path)
          ) {
            await gh.deleteFile({
              owner: repo.owner,
              repo: repo.repo,
              path,
              branch: args.branch,
              message: `Remove omitted proposal file ${path}`,
            });
          }
        }
      } catch (err) {
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
    async updatePullRequest(repo, args) {
      try {
        return await clientFor(repo).updatePullRequest({
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
          mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
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
