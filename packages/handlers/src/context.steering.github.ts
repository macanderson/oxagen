// context.steering.github.ts — the GitHub seam under the Context PR handlers
// (ADR-061; MC spec §10.1, §10.3). The workspace's repository is its
// **steering repository**: the steering head's binding
// (`ingestion.repository_binding_heads` → `ingestion.repository_bindings`),
// which is the system of record for repository identity per MC spec §10.1.
// Its production branch is the default ref that binding recorded — the one an
// org owner approved — not whatever GitHub reports as the default branch
// today. Every operation runs with the workspace's own token (ADR-020:
// installation token, then the connecting user's OAuth token, then the
// local-only PAT). A steering repository the provisioner created is the one
// exception: only the Oxagen GitHub App can reach it, so the seam mints that
// app's installation token for it.
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import {
  createGitHubClient,
  GitHubApiError,
  githubPath,
  githubRest,
  recordSteeringDeployment,
  type GitHubClient,
  type GitHubPathCommit,
  type GitHubRest,
} from "@oxagen/github";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { logger } from "./logger";
import { resolveGitHubToken } from "./lib/github-token";
import {
  GITHUB_STEERING_PROVIDER,
  mintSteeringInstallationToken,
  steeringAppFromEnv,
  STEERING_APP_UNCONFIGURED_MESSAGE,
} from "./lib/steering-app";

import { assertGithubSteeringCommit } from "./steering-repo/diverged";

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
  /** True when the trusted binding identifies a provisioned steering repository. */
  requiresSteeringProvenance?: boolean;
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
   * For a BOUND repository this is the binding's `configured_default_ref`,
   * the ref recorded with that binding version, and NOT whatever GitHub
   * currently reports as the repository's default branch. Changing the
   * default branch on GitHub must not move steering onto a branch nobody
   * approved; only a new binding version does that. See
   * `readGitHubConnection`, which is the one source of this fact.
   */
  defaultBranch: string;
}

/** One file in a commit's tree: its path, and its git blob id. */
export interface SteeringTreeEntry {
  path: string;
  blob: string;
}

/**
 * The port every steering handler publishes through (ADR-061). The method
 * names are GitHub's because GitHub was the first host; a GitLab
 * implementation answers the same calls with merge requests, commit statuses
 * and project access tokens (#3762). `createSteeringHost` picks the host from
 * the workspace's main repository binding.
 */
export interface SteeringHost {
  /** Refuse an unverified commit before syncing or publishing its files. */
  assertSteeringCommit?(repo: SteeringRepository, commit: string): Promise<void>;
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
  /**
   * Create the branch from `fromBranch`; an existing branch is reused. With
   * `at`, the branch starts at that commit instead of at `fromBranch`'s head.
   * The host creates it there in one call, so nothing moves it in between.
   */
  ensureBranch(
    repo: SteeringRepository,
    branch: string,
    fromBranch: string,
    options?: { exclusive: boolean; at?: string },
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
    /** False once the host closed it, merged or not. */
    open: boolean;
    merged: boolean;
    mergeCommitSha: string | null;
    mergedAt: Date | null;
  }>;
  /**
   * The commit at the tip of `branch`, or null when the host has no such
   * branch. The repository sync reads the production branch through this and
   * then reads every file at that one commit, so the files agree.
   */
  branchHead(repo: SteeringRepository, branch: string): Promise<string | null>;
  /** Every file path under the directory `dir` at `ref`, at any depth. */
  listFiles(
    repo: SteeringRepository,
    ref: string,
    dir: string,
  ): Promise<string[]>;
  /**
   * Every file at `commit`, with its git blob id. A publish reads the merged
   * tree through this, and skips fetching a file whose blob it already holds.
   */
  listTree(
    repo: SteeringRepository,
    commit: string,
  ): Promise<SteeringTreeEntry[]>;
  /**
   * Tag the commit `sha` as `name`. A tag already at `sha` is left as it is,
   * so a publish that runs again succeeds. A tag at another commit refuses
   * with `tag_exists`.
   */
  createTag(repo: SteeringRepository, name: string, sha: string): Promise<void>;
  /**
   * Every path the commit `head` changes against `base`, as its pull request
   * shows them; a rename names both its paths. Refuses with `too_many_files`
   * at 300 files, where the host's list may be cut short.
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
  /**
   * Squash-merge, pinned to `sha`: the host refuses when the head moved past
   * it. `commitMessage` is the squash commit's body, where the merge queue
   * puts the `Oxagen-*` trailers (#4449). The merge queue pushes the stamp
   * commit just before it calls this, and a host checks whether a pull
   * request can merge only after each push. So each host waits for its own
   * check to finish, briefly, before it merges (#5157).
   */
  mergePullRequest(
    repo: SteeringRepository,
    args: {
      number: number;
      commitTitle: string;
      sha: string;
      commitMessage?: string;
    },
  ): Promise<{ sha: string }>;
  closePullRequest(repo: SteeringRepository, number: number): Promise<void>;
  /** Delete the branch; a branch already gone is not an error. */
  deleteBranch(repo: SteeringRepository, branch: string): Promise<void>;
  /**
   * What the commit `head` does to each path against `base`. A rename is a
   * removal of the old path and an addition of the new one, because the stamp
   * and the ledger speak of paths, not of moves. Refuses with
   * `too_many_files` at 300 files, as {@link SteeringHost.changedPaths} does.
   */
  changedFiles(
    repo: SteeringRepository,
    base: string,
    head: string,
  ): Promise<SteeringChangedFile[]>;
  /**
   * Write one commit on `branch` whose only parent is `parent`: each file
   * with content is written, each file with null content is deleted. The
   * host refuses with `head_moved` when the branch no longer points at
   * `parent`, so a stamp never lands on a head nobody checked.
   */
  commitFiles(
    repo: SteeringRepository,
    args: {
      branch: string;
      parent: string;
      message: string;
      files: { path: string; content: string | null }[];
    },
  ): Promise<{ sha: string }>;
  /** True when `ancestor` is `head` or one of its ancestors. */
  holdsCommit(
    repo: SteeringRepository,
    head: string,
    ancestor: string,
  ): Promise<boolean>;
  /**
   * The parents of the commit `sha`, in git's order. A squash merge has one:
   * the production branch head it landed on. A merge commit's first parent
   * is the branch it merged into. A root commit has none. A revert reads the
   * first parent to learn what the production branch held before the merge.
   */
  commitParents(repo: SteeringRepository, sha: string): Promise<string[]>;
  /**
   * Bring the steering PR's branch up to date with the production branch.
   * Refuses with `head_moved` when the branch is not at `expectedHead`, and
   * with `update_conflict` when the production branch does not merge in
   * cleanly. Answers the branch's new head. When the update made a merge
   * commit, it also answers that commit's parents in order.
   *
   * GitHub merges `base`, the production branch head Oxagen read, so the
   * parents are `expectedHead` and then `base`. GitLab rebases onto the
   * production branch as it is when the rebase runs. A rebase makes no merge
   * commit, so `parents` is null there.
   */
  updateBranch(
    repo: SteeringRepository,
    args: {
      number: number;
      branch: string;
      expectedHead: string;
      base: string;
    },
  ): Promise<{ headSha: string; parents: string[] | null }>;
  /**
   * Point `branch` back at `to` while it still points at `from`, discarding
   * the commits between them. The answer is false when the branch has moved
   * off `from`: it holds a push Oxagen did not make, so it is left alone.
   * GitHub checks and moves the ref in one step. GitLab has no guarded move,
   * so it reads the branch first, and a push between the read and the reset
   * is lost.
   */
  resetBranch(
    repo: SteeringRepository,
    branch: string,
    args: { from: string; to: string },
  ): Promise<boolean>;
  /** The approvals the PR holds now, one per reviewer. */
  listApprovals(
    repo: SteeringRepository,
    number: number,
  ): Promise<SteeringApproval[]>;
  /**
   * Record a publish as a successful deployment of `sha` to `environment`,
   * so the host's own deployments page lists every steering version.
   */
  recordDeployment(
    repo: SteeringRepository,
    args: {
      sha: string;
      ref: string;
      environment: string;
      description: string;
    },
  ): Promise<{ url: string | null }>;
}

/** One path a commit changes, as the stamp and the ledger read it. */
export interface SteeringChangedFile {
  path: string;
  status: "added" | "modified" | "removed";
}

/**
 * One reviewer's standing approval on a steering PR.
 *
 * `userId` is the Oxagen user the host account is linked to, or null when
 * nobody linked it: an approval by a stranger to the workspace counts for
 * nothing. `commitSha` is the head the reviewer approved, or null when the
 * host did not name one, in which case the approval stands whatever the head
 * is now. GitLab never names one, so its adapter places each approval on the
 * newest diff version GitLab recorded before `approved_at`, and never reports
 * null. A GitLab project that keeps approvals on push, or an approval with no
 * readable `approved_at`, refuses with `approvals_not_head_bound`.
 */
export interface SteeringApproval {
  userId: string | null;
  login: string;
  commitSha: string | null;
}

/** The GitHub implementation of {@link SteeringHost}. */
export type SteeringGitHub = SteeringHost;

interface DeliveryConfig {
  owner?: unknown;
  repo?: unknown;
  /**
   * The Oxagen GitHub App's installation id, on a `github_steering`
   * connection the steering repo provisioner wrote.
   */
  installationId?: unknown;
}

/**
 * The installation id on a `github_steering` connection's delivery config, as
 * a positive integer. The provisioner writes a number. A string of digits
 * reads too, because the settings-path GitHub connections store theirs as one.
 */
function steeringInstallationIdOf(
  config: DeliveryConfig | null,
): number | null {
  const raw = config?.installationId;
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
      /**
       * Set when the head hangs from a `github_steering` connection: the
       * steering repo provisioner created the repository through the Oxagen
       * Steering app, and only that app's installation can reach it. The seam
       * then mints that installation's token, not the workspace's own.
       */
      steeringInstallationId?: number;
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
 * workspaces would lose steering; with it, a workspace that later gets a
 * steering head is answered from the binding, which wins.
 *
 * The fallback is narrowed to the case it exists for: NO BINDING HEAD AT ALL.
 * The joined read above misses for two different reasons — no head was ever
 * written, or a head exists and the connection it was bound through is
 * retired — and they are not the same fact. Falling back on the second one
 * silently retargets steering and every Context PR at whatever unrelated
 * repository a still-connected legacy sources connection happens to name in
 * its ingestion `delivery_config`. Writing steering into the wrong repository
 * is worse than steering being off, so a workspace whose steering repository
 * is bound but unreachable answers null and its callers refuse. No capability
 * repairs that state yet (#4637).
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
        connectorId: schema.sourceConnections.connectorId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
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
          // Only the steering head steers. Its role is 'steering', and
          // 'linked' marks a code repository the workspace's agents work in,
          // which receives no Context PR, because every record lives in the
          // steering repository (ADR-212). A reader
          // that ignores the column goes on resolving through a linked
          // head, so the cross-workspace steering collision the index
          // forbids would survive the reconciliation meant to end it.
          inArray(
            schema.repositoryBindingHeads.role,
            schema.STEERING_HEAD_ROLES,
          ),
          eq(schema.repositoryBindingHeads.provider, "github"),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, [
            ...RETIRED_CONNECTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    if (bound) {
      const answer = {
        source: "binding" as const,
        owner: bound.owner,
        repo: bound.repo,
        approvedFullName: bound.approvedFullName,
        approvedDefaultRef: bound.approvedDefaultRef,
      };
      if (bound.connectorId !== GITHUB_STEERING_PROVIDER) return answer;
      // A provisioned steering repository. The workspace's own GitHub token
      // cannot see it, so the seam needs the Oxagen GitHub App installation the
      // provisioner recorded. Without one, every call would fail on GitHub
      // with a 404 that names no cause, so the read refuses here instead.
      const installationId = steeringInstallationIdOf(
        bound.deliveryConfig as DeliveryConfig | null,
      );
      if (installationId === null)
        throw new HandlerError({
          code: "conflict",
          reason: "steering_installation_missing",
          message: `The steering repository ${bound.approvedFullName} hangs from a steering connection with no installation id, so Oxagen cannot reach it. Provision the steering repository again.`,
        });
      return { ...answer, steeringInstallationId: installationId };
    }

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
          // Only the steering head (role 'steering') declares the
          // steering repository. A linked head (`link_repository`) declares
          // nothing about steering, and counting it would report "bound but
          // retired" for a workspace whose linked repository is all it has.
          inArray(
            schema.repositoryBindingHeads.role,
            schema.STEERING_HEAD_ROLES,
          ),
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
  /**
   * The Oxagen GitHub App's token for one installation, used when the
   * steering head hangs from a `github_steering` connection. Defaults to
   * {@link mintSteeringInstallationToken}.
   */
  steeringToken?: (installationId: number) => Promise<string>;
  /**
   * The plain REST calls the merge queue makes that `GitHubClient` does not
   * carry: git data, branch updates, reviews, deployments. Defaults to
   * `githubRest` with the same token.
   */
  rest?: (token: string) => GitHubRest;
  /** The Oxagen user a host account is linked to. Defaults to {@link linkedOxagenUser}. */
  linkAccount?: (providerId: string, accountId: string) => Promise<string | null>;
  /** The pause between two reads of a pull request's mergeability. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The Oxagen user who signed in with the host account `accountId`, or null
 * when no Oxagen user linked it. The provider id is Better Auth's: `github`
 * for a GitHub login. This is how a review on the host becomes an approval
 * by a workspace member.
 */
export async function linkedOxagenUser(
  providerId: string,
  accountId: string,
): Promise<string | null> {
  // tenancy: global. auth.accounts is platform state with no org_id column,
  // and no tenant owns the link between a login and a user. The query is
  // filtered to one providerId and the host's own accountId.
  const [row] = await withSystemDb((tx) =>
    tx
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.providerId, providerId),
          eq(schema.accounts.accountId, accountId),
        ),
      )
      .limit(1),
  );
  return row?.userId ?? null;
}

/**
 * The reviews that stand on a PR, one per reviewer: the reviewer's latest
 * review that approves, requests changes, or dismisses. A comment or a
 * pending review changes nothing. Reviews arrive oldest first.
 */
export function standingApprovals<
  R extends {
    user: { id: number; login: string } | null;
    state: string;
    commit_id: string | null;
  },
>(reviews: readonly R[]): R[] {
  const latest = new Map<number, R>();
  for (const review of reviews) {
    if (!review.user) continue;
    if (
      review.state === "APPROVED" ||
      review.state === "CHANGES_REQUESTED" ||
      review.state === "DISMISSED"
    )
      latest.set(review.user.id, review);
  }
  return [...latest.values()].filter((r) => r.state === "APPROVED");
}

/**
 * How many times a merge reads the pull request while GitHub checks whether
 * it can merge. GitHub runs that check in the background after every push,
 * and the pull request reads `mergeable: null` until it finishes. A merge sent
 * in that window is refused with 405 "Pull Request is not mergeable". The
 * merge queue pushes the stamp commit a moment before it merges, so without a
 * wait every steering merge lost that race (#5157). Ten reads one second
 * apart keep the wait under ten seconds, as the GitLab host's does, because
 * the merge runs inside an API request.
 */
const MERGEABILITY_READS = 10;
const MERGEABILITY_PAUSE_MS = 1000;

/** The fields of a pull request that say whether GitHub can merge it now. */
interface GithubMergeability {
  state: "open" | "closed";
  head: { sha: string };
  /** Null while GitHub is still checking the head. */
  mergeable: boolean | null;
  /** `clean`, `dirty` (a conflict), `unknown` (still checking), and others. */
  mergeable_state?: string;
}

/** GitHub's 405 for a pull request whose mergeability it has not worked out. */
function isNotMergeable(err: unknown): boolean {
  return (
    err instanceof GitHubApiError &&
    err.status === 405 &&
    /not mergeable/i.test(err.message)
  );
}

/** GitHub reports that the pull request conflicts with its base. */
function conflictsWithBase(
  repo: SteeringRepository,
  number: number,
  mergeableState: string | undefined,
): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "not_mergeable",
    message: `GitHub reports that #${number} in ${repo.fullName} cannot merge into ${repo.defaultBranch} (mergeable_state ${mergeableState ?? "unknown"}), so nothing merged. Resolve the conflict on the steering PR, then merge again.`,
  });
}

/** GitHub had not finished checking the pull request when the wait ran out. */
function mergeabilityUnknown(
  repo: SteeringRepository,
  number: number,
  mergeableState: string | undefined,
): HandlerError {
  const seconds = ((MERGEABILITY_READS - 1) * MERGEABILITY_PAUSE_MS) / 1000;
  return new HandlerError({
    code: "conflict",
    reason: "mergeability_unknown",
    message: `GitHub had not finished checking whether #${number} in ${repo.fullName} can merge after ${seconds} seconds (mergeable_state ${mergeableState ?? "unknown"}), so nothing merged. Merge again in a minute.`,
  });
}

/** A git ref update that is not a fast forward means the branch moved. */
function headMoved(branch: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "head_moved",
    message: `The steering PR's branch ${branch} moved while Oxagen was merging it. Merge again to check the new head.`,
  });
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
 * A Context PR that the host merged at a commit the checks never ran on.
 *
 * Someone merged it on the host instead of from Oxagen, after the head moved:
 * a merge of `main` into the branch, or a review bot's suggestion accepted
 * into the record file. Running the checks again cannot help, because a
 * merged pull request's head never moves again. The production branch now
 * holds whatever merged, and the repository sync (ADR-184) publishes that:
 * the record file is the record. This refusal says so, and the handlers ask
 * for the sync before they throw it.
 */
export function mergedOutsideOxagen(
  prUrl: string | null,
  mergedHead: string | null,
): HandlerError {
  const at = mergedHead ? ` at ${mergedHead}` : "";
  return new HandlerError({
    code: "conflict",
    reason: "merged_outside_oxagen",
    message: `Someone merged ${prUrl ?? "this pull request"} on the repository host${at}. Oxagen is reading the production branch now, and this proposal shows what it published within a minute.`,
  });
}

/**
 * Ask for the repository sync for a Context PR the host already merged, then
 * refuse. The sync runs through its queue (one per workspace at a time), not
 * inside this request: run here, it could write an older branch head over a
 * newer one the queue had already written.
 */
export async function refuseMergedOnHost(
  deps: {
    requestSync?: (scope: {
      orgId: string;
      workspaceId: string;
    }) => Promise<unknown>;
  },
  scope: { orgId: string; workspaceId: string },
  row: { publicId: string; prUrl: string | null },
  mergedHead: string | null,
): Promise<never> {
  try {
    await deps.requestSync?.(scope);
  } catch (err) {
    logger.warn(
      { err, proposal: row.publicId },
      "context.steering: could not request a sync after a merge on the host; the scheduled sweep runs it",
    );
  }
  throw mergedOutsideOxagen(row.prUrl, mergedHead);
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
 * GitHub's compare answers at most 300 files and does not say when it cut the
 * list. A list that long may be missing paths, so the branch-scope check and
 * the stamp would each see only part of the change.
 */
const COMPARE_FILE_LIMIT = 300;

/**
 * Refuse a compare that may have been cut short. Both hosts call it, so
 * GitHub and GitLab refuse the same change; GitLab's own limit is higher.
 */
export function refuseLongCompare(
  files: number,
  base: string,
  head: string,
): void {
  if (files < COMPARE_FILE_LIMIT) return;
  throw new HandlerError({
    code: "conflict",
    reason: "too_many_files",
    message: `${head} changes ${files} or more files against ${base}. Oxagen reads at most ${COMPARE_FILE_LIMIT - 1} files in one steering PR, so split it into smaller steering PRs.`,
  });
}

/**
 * Move one branch ref, but only while it points at `beforeOid`. GitHub
 * applies every update in the list or none of them.
 */
const RESET_BRANCH = `mutation ResetSteeringBranch(
  $repositoryId: ID!
  $refUpdates: [RefUpdate!]!
) {
  updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) {
    clientMutationId
  }
}`;

/** The refusal for a tag that already names another commit. */
export function tagExists(
  fullName: string,
  name: string,
  tagged: string,
  sha: string,
): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "tag_exists",
    message: `The tag ${name} in ${fullName} already names commit ${tagged}, so it was not moved to ${sha}.`,
  });
}

interface GitTreeListing {
  truncated?: boolean;
  tree: { path: string; type: string; sha: string }[];
}

/**
 * Every blob under the tree `treeSha`, with its blob id. GitHub cuts a
 * recursive listing short on a very large tree and flags it `truncated`, so a
 * cut listing is walked again one directory at a time. A partial tree is never
 * returned as the whole one, because a publish would read a file it cannot see
 * as deleted.
 */
async function listGitTree(
  rest: GitHubRest,
  repoPath: string,
  treeSha: string,
): Promise<SteeringTreeEntry[]> {
  const whole = await rest.request<GitTreeListing>(
    "GET",
    `${repoPath}/git/trees/${githubPath(treeSha)}?recursive=1`,
  );
  if (!whole.data.truncated)
    return whole.data.tree
      .filter((item) => item.type === "blob")
      .map((item) => ({ path: item.path, blob: item.sha }));
  const entries: SteeringTreeEntry[] = [];
  const pending = [{ sha: treeSha, prefix: "" }];
  for (let dir = pending.pop(); dir; dir = pending.pop()) {
    const level = await rest.request<GitTreeListing>(
      "GET",
      `${repoPath}/git/trees/${githubPath(dir.sha)}`,
    );
    if (level.data.truncated)
      throw new HandlerError({
        code: "conflict",
        reason: "tree_too_large",
        message: `GitHub cut short the listing of the directory ${dir.prefix || "/"} in ${repoPath}, so the tree cannot be read whole.`,
      });
    for (const item of level.data.tree) {
      const itemPath = `${dir.prefix}${item.path}`;
      if (item.type === "blob")
        entries.push({ path: itemPath, blob: item.sha });
      else if (item.type === "tree")
        pending.push({ sha: item.sha, prefix: `${itemPath}/` });
    }
  }
  return entries;
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
  const provisioned = new WeakSet<SteeringRepository>();
  const repositoryIds = new WeakMap<SteeringRepository, number>();
  // The plain REST calls, built with the same token and keyed the same way.
  const rests = new WeakMap<SteeringRepository, GitHubRest>();
  const makeRest = deps.rest ?? ((token: string) => githubRest({ token }));
  const linkAccount = deps.linkAccount ?? linkedOxagenUser;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
  const restFor = (repo: SteeringRepository) => {
    const rest = rests.get(repo);
    if (!rest)
      throw new Error(`[context.steering] no client for ${repo.fullName}`);
    const path = `/repos/${githubPath(repo.owner)}/${githubPath(repo.repo)}`;
    return { rest, path };
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
      // A provisioned steering repository answers only to the Oxagen GitHub
      // App. Every other head uses the workspace's own token.
      const token =
        connection.source === "binding" &&
        connection.steeringInstallationId !== undefined
          ? await (deps.steeringToken ?? mintSteeringInstallationToken)(
              connection.steeringInstallationId,
            )
          : await deps.resolveToken(scope);
      const gh = deps.client(token);
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
      // binding is written, the immutable binding and the settings page still
      // name the approved branch, and steering must agree with them.
      // Following GitHub instead would open, check and merge Context PRs into
      // a branch no one approved, while `assertProductionBase` below — which
      // compares a PR's base against this very field — would wave it through.
      // Approving a new branch is a new binding version
      // (`set_production_branch`), which is the only thing that moves this.
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
        // it. Nothing re-records a renamed repository's name on its own since
        // #4616. `set_production_branch` writes the live name into the
        // successor binding when it moves the branch.
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
      const requiresSteeringProvenance =
        connection.source === "binding" &&
        connection.steeringInstallationId !== undefined;
      const repo: SteeringRepository = {
        ...(requiresSteeringProvenance ? { requiresSteeringProvenance: true } : {}),
        provider: "github",
        owner: connection.owner,
        repo: connection.repo,
        fullName,
        currentFullName: info.fullName,
        defaultBranch,
      };
      if (requiresSteeringProvenance) provisioned.add(repo);
      const repositoryId = Number(info.id);
      if (Number.isSafeInteger(repositoryId) && repositoryId > 0)
        repositoryIds.set(repo, repositoryId);
      clients.set(repo, gh);
      rests.set(repo, makeRest(token));
      return repo;
    },
    async assertSteeringCommit(repo, commit) {
      const { rest } = restFor(repo);
      if (!provisioned.has(repo)) return;
      const config = steeringAppFromEnv();
      if (config === null)
        throw new HandlerError({
          code: "conflict",
          reason: "steering_app_unconfigured",
          message: STEERING_APP_UNCONFIGURED_MESSAGE,
        });
      await assertGithubSteeringCommit(
        {
          repo: { owner: repo.owner, name: repo.repo, id: repositoryIds.get(repo) },
          app: config.app,
          defaultBranch: repo.defaultBranch,
          rest: {
            async request<T>(
              method: string,
              path: string,
              body?: unknown,
              accept: readonly number[] = [],
            ) {
              try {
                const response = await rest.request<T>(method, path, body);
                return { ...response, message: null };
              } catch (error) {
                if (
                  error instanceof GitHubApiError &&
                  accept.includes(error.status)
                )
                  return {
                    status: error.status,
                    data: null,
                    message: error.message,
                  };
                throw error;
              }
            },
          },
        },
        commit,
      );
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
          fromSha: options?.at,
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
        refuseLongCompare(files.length, base, head);
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
          open: pr.state === "open",
          merged: pr.merged,
          mergeCommitSha: pr.mergeCommitSha,
          mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
        };
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async branchHead(repo, branch) {
      try {
        const out = await clientFor(repo).getBranch({
          owner: repo.owner,
          repo: repo.repo,
          branch,
        });
        return out?.sha ?? null;
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async listFiles(repo, ref, dir) {
      try {
        const paths = await clientFor(repo).getTree({
          owner: repo.owner,
          repo: repo.repo,
          ref,
          path: dir,
        });
        return paths.filter((path) => path.startsWith(`${dir}/`));
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async listTree(repo, commit) {
      const { rest, path } = restFor(repo);
      try {
        const head = await rest.request<{ tree: { sha: string } }>(
          "GET",
          `${path}/git/commits/${githubPath(commit)}`,
        );
        return await listGitTree(rest, path, head.data.tree.sha);
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async createTag(repo, name, sha) {
      const { rest, path } = restFor(repo);
      try {
        await rest.request("POST", `${path}/git/refs`, {
          ref: `refs/tags/${name}`,
          sha,
        });
        return;
      } catch (err) {
        if (!(err instanceof GitHubApiError && err.status === 422))
          throw githubRefused(err);
      }
      // GitHub answers 422 when the tag exists. At `sha` it is this tag,
      // written by an earlier run of the same publish.
      let tagged: string;
      try {
        const out = await rest.request<{ object: { sha: string } }>(
          "GET",
          `${path}/git/ref/tags/${githubPath(name)}`,
        );
        tagged = out.data.object.sha;
      } catch (err) {
        throw githubRefused(err);
      }
      if (tagged !== sha) throw tagExists(repo.fullName, name, tagged, sha);
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
      const { rest, path } = restFor(repo);
      const send = async (): Promise<{ sha: string }> => {
        if (args.commitMessage !== undefined) {
          // The shared client sends no commit body, and the trailers live in
          // the body, so a merge that carries them goes through REST.
          const out = await rest.request<{ sha: string }>(
            "PUT",
            `${path}/pulls/${args.number}/merge`,
            {
              merge_method: "squash",
              commit_title: args.commitTitle,
              commit_message: args.commitMessage,
              sha: args.sha,
            },
          );
          return { sha: out.data.sha };
        }
        const out = await clientFor(repo).mergePullRequest({
          owner: repo.owner,
          repo: repo.repo,
          number: args.number,
          mergeMethod: "squash",
          commitTitle: args.commitTitle,
          sha: args.sha,
        });
        return { sha: out.sha };
      };
      // GitHub checks whether the pull request can merge after each push,
      // and the merge queue pushed the stamp commit just now. Reading the
      // pull request also starts that check. Merge once GitHub has checked
      // `sha`, or once the reads run out (#5157).
      for (let read = 1; ; read += 1) {
        let pull: GithubMergeability;
        try {
          pull = (
            await rest.request<GithubMergeability>(
              "GET",
              `${path}/pulls/${args.number}`,
            )
          ).data;
        } catch (err) {
          throw githubRefused(err);
        }
        const open = pull.state === "open";
        const atSha = pull.head.sha === args.sha;
        if (open && atSha && pull.mergeable === false)
          throw conflictsWithBase(repo, args.number, pull.mergeable_state);
        const last = read >= MERGEABILITY_READS;
        // A closed pull request goes straight to the merge, whose refusal
        // says why. So does an open one that still reads another head when
        // the reads run out: GitHub refuses the pinned merge with 409.
        if (!open || (atSha && pull.mergeable === true) || last) {
          try {
            return await send();
          } catch (err) {
            if (!open || !isNotMergeable(err)) throw githubRefused(err);
            if (last)
              throw mergeabilityUnknown(
                repo,
                args.number,
                pull.mergeable_state,
              );
            // GitHub can still answer 405 for a moment after it reports the
            // pull request mergeable. Read it again and retry.
          }
        }
        await sleep(MERGEABILITY_PAUSE_MS);
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
    async changedFiles(repo, base, head) {
      try {
        const files = await clientFor(repo).compareCommits({
          owner: repo.owner,
          repo: repo.repo,
          base,
          head,
        });
        refuseLongCompare(files.length, base, head);
        return files.flatMap((f): SteeringChangedFile[] => {
          if (f.status === "renamed" && f.previousPath)
            return [
              { path: f.previousPath, status: "removed" },
              { path: f.path, status: "added" },
            ];
          if (f.status === "added" || f.status === "copied")
            return [{ path: f.path, status: "added" }];
          if (f.status === "removed")
            return [{ path: f.path, status: "removed" }];
          return [{ path: f.path, status: "modified" }];
        });
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async commitFiles(repo, args) {
      const { rest, path } = restFor(repo);
      let sha: string;
      try {
        const parent = await rest.request<{ tree: { sha: string } }>(
          "GET",
          `${path}/git/commits/${encodeURIComponent(args.parent)}`,
        );
        const tree = await rest.request<{ sha: string }>(
          "POST",
          `${path}/git/trees`,
          {
            base_tree: parent.data.tree.sha,
            tree: args.files.map((f) =>
              f.content === null
                ? { path: f.path, mode: "100644", type: "blob", sha: null }
                : {
                    path: f.path,
                    mode: "100644",
                    type: "blob",
                    content: f.content,
                  },
            ),
          },
        );
        const commit = await rest.request<{ sha: string }>(
          "POST",
          `${path}/git/commits`,
          {
            message: args.message,
            tree: tree.data.sha,
            parents: [args.parent],
          },
        );
        sha = commit.data.sha;
      } catch (err) {
        throw githubRefused(err);
      }
      try {
        // `force: false` makes GitHub refuse anything but a fast forward, so
        // the stamp lands only on the head it was written against.
        await rest.request(
          "PATCH",
          `${path}/git/refs/heads/${githubPath(args.branch)}`,
          { sha, force: false },
        );
      } catch (err) {
        // 422 here is GitHub's "Update is not a fast forward": the branch
        // moved after the parent was read.
        if (err instanceof GitHubApiError && err.status === 422)
          throw headMoved(args.branch);
        throw githubRefused(err);
      }
      return { sha };
    },
    async holdsCommit(repo, head, ancestor) {
      if (head === ancestor) return true;
      const { rest, path } = restFor(repo);
      try {
        const out = await rest.request<{ status: string }>(
          "GET",
          `${path}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(head)}?per_page=1`,
        );
        return out.data.status === "ahead" || out.data.status === "identical";
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async commitParents(repo, sha) {
      const { rest, path } = restFor(repo);
      try {
        const out = await rest.request<{ parents?: { sha: string }[] }>(
          "GET",
          `${path}/git/commits/${encodeURIComponent(sha)}`,
        );
        return (out.data.parents ?? []).map((parent) => parent.sha);
      } catch (err) {
        throw githubRefused(err);
      }
    },
    async updateBranch(repo, args) {
      const { rest, path } = restFor(repo);
      try {
        const current = await clientFor(repo).getBranch({
          owner: repo.owner,
          repo: repo.repo,
          branch: args.branch,
        });
        if (current?.sha !== args.expectedHead) throw headMoved(args.branch);
        const out = await rest.request<
          { sha: string; parents?: { sha: string }[] } | undefined
        >("POST", `${path}/merges`, {
          base: args.branch,
          // The sha, not the branch name, so the second parent is the head
          // Oxagen read even when the production branch moves meanwhile.
          head: args.base,
        });
        // 204: the branch already holds the production branch.
        if (!out.data) return { headSha: args.expectedHead, parents: null };
        // GitHub merges into the branch as it is when the request lands. A
        // push after the read above becomes the first parent, and the
        // approvals would carry onto a commit nobody reviewed.
        const parents = out.data.parents?.map((p) => p.sha) ?? [];
        if (parents[0] !== args.expectedHead) throw headMoved(args.branch);
        return { headSha: out.data.sha, parents };
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 409)
          throw new HandlerError({
            code: "conflict",
            reason: "update_conflict",
            message: `${repo.defaultBranch} does not merge cleanly into ${args.branch}. Resolve the conflict on the steering PR, then merge again.`,
          });
        throw githubRefused(err);
      }
    },
    async resetBranch(repo, branch, args) {
      const { rest, path } = restFor(repo);
      // The REST ref update takes no expected value, so the reset goes
      // through GraphQL, whose `beforeOid` moves the ref only while it still
      // points at `from`. The client's base is api.github.com, so `/graphql`
      // is GitHub's own endpoint.
      let refusal: unknown;
      try {
        const info = await rest.request<{ node_id: string }>("GET", path);
        const out = await rest.request<{ errors?: { message: string }[] }>(
          "POST",
          "/graphql",
          {
            query: RESET_BRANCH,
            variables: {
              repositoryId: info.data.node_id,
              refUpdates: [
                {
                  name: `refs/heads/${branch}`,
                  afterOid: args.to,
                  beforeOid: args.from,
                  force: true,
                },
              ],
            },
          },
        );
        // GraphQL answers 200 and puts a refusal in `errors`.
        const errors = out.data.errors ?? [];
        if (errors.length === 0) return true;
        refusal = new Error(errors.map((e) => e.message).join("; "));
      } catch (err) {
        refusal = err;
      }
      // The refusal does not say whether the check on `from` failed, so the
      // branch is read again. A branch at `to` took the reset before the
      // answer was lost. A branch anywhere else but `from` moved.
      let now: string | null;
      try {
        const out = await clientFor(repo).getBranch({
          owner: repo.owner,
          repo: repo.repo,
          branch,
        });
        now = out?.sha ?? null;
      } catch {
        throw githubRefused(refusal);
      }
      if (now === args.to) return true;
      if (now !== args.from) return false;
      throw githubRefused(refusal);
    },
    async listApprovals(repo, number) {
      const { rest, path } = restFor(repo);
      type Review = {
        user: { id: number; login: string } | null;
        state: string;
        commit_id: string | null;
      };
      const reviews: Review[] = [];
      try {
        // A PR with more than 100 reviews pages; stop at the first short page.
        for (let page = 1; ; page++) {
          const out = await rest.request<Review[]>(
            "GET",
            `${path}/pulls/${number}/reviews?per_page=100&page=${page}`,
          );
          reviews.push(...out.data);
          if (out.data.length < 100) break;
        }
      } catch (err) {
        throw githubRefused(err);
      }
      const standing = standingApprovals(reviews).flatMap((r) =>
        r.user ? [{ user: r.user, commitSha: r.commit_id }] : [],
      );
      return Promise.all(
        standing.map(async ({ user, commitSha }) => ({
          userId: await linkAccount("github", String(user.id)),
          login: user.login,
          commitSha,
        })),
      );
    },
    async recordDeployment(repo, args) {
      const { rest } = restFor(repo);
      try {
        const out = await recordSteeringDeployment(rest, {
          owner: repo.owner,
          repo: repo.repo,
          sha: args.sha,
          environment: args.environment,
          description: args.description,
        });
        return { url: out.url };
      } catch (err) {
        throw githubRefused(err);
      }
    },
  };
}
