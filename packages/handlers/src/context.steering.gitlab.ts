// context.steering.gitlab.ts: the GitLab implementation of the steering port
// (#3762; ADR-061). A Context PR on GitLab is a merge request, a check is a
// commit status, and every call authenticates with the project access token
// the workspace connected.
//
// Three GitLab facts shape this file:
//
// - A project is addressed by its numeric id, never by its path. A project
//   transferred to another group, or renamed, keeps its id; the binding pins
//   the id, and the path is only a label (`currentFullName`).
// - A merge request's IID is unique within its project, and is the number a
//   person sees. It fills the port's `number`, which on GitHub is also scoped
//   to one repository. It is never a global id, and a proposal records which
//   host its number belongs to (`context_proposals.provider`).
// - The merge is pinned with `sha`, so GitLab refuses when the head moved past
//   the commit the checks ran on. GitHub gives the same guarantee.
import { schema, withTenantDb } from "@oxagen/database";
import {
  createGitLabClient,
  GitLabApiError,
  type GitLabClient,
  type GitLabCommitAction,
  type GitLabMergeRequest,
} from "@oxagen/gitlab";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import {
  linkedOxagenUser,
  refuseLongCompare,
  type SteeringChangedFile,
  type SteeringHost,
  type SteeringRepository,
} from "./context.steering.github";
import {
  GITLAB_PROVIDER,
  resolveGitLabCredential,
} from "./lib/gitlab-credential";
import { logger } from "./logger";

type GitLabRepository = Extract<SteeringRepository, { provider: "gitlab" }>;

const RETIRED_CONNECTION_STATUSES = ["deleting", "deleted"] as const;

/**
 * The merge statuses that mean GitLab is still deciding whether the merge
 * request can merge. A merge attempted during one of them is refused with 405
 * or 422 even though nothing is wrong, so the merge waits them out first.
 */
const PENDING_MERGE_STATUSES = new Set([
  "checking",
  "unchecked",
  "preparing",
  "approvals_syncing",
]);

/** GitLab caps a commit status description at 255 characters. */
const STATUS_DESCRIPTION_LIMIT = 255;

/** How many times the branch update polls a rebase before giving up. */
const REBASE_POLL_LIMIT = 30;

const GITLAB_BASE_URL = "https://gitlab.com";
const GITLAB_REQUEST_TIMEOUT_MS = 30_000;
/** Longest GitLab error text kept in a message, as the client keeps it. */
const GITLAB_MESSAGE_LIMIT = 500;

/** One answer from {@link GitLabRest}. */
export interface GitLabRestResponse<T> {
  status: number;
  data: T;
}

/**
 * The GitLab calls the shared client does not make: rebase, merge base,
 * approvals and deployments. A non-2xx answer throws `GitLabApiError`, and the
 * token never appears in its message.
 */
export interface GitLabRest {
  request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitLabRestResponse<T>>;
}

function gitlabErrorText(bodyText: string, statusText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    const detail = body.message ?? body.error;
    if (typeof detail === "string") return detail;
    if (detail !== undefined) return JSON.stringify(detail);
  }
  return statusText || "request failed";
}

/**
 * A plain GitLab REST v4 caller built on one token. The token travels in the
 * `PRIVATE-TOKEN` header and is scrubbed from every error message, because
 * those messages reach logs and proposal rows.
 */
export function gitlabRest(opts: {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): GitLabRest {
  const baseUrl = (opts.baseUrl ?? GITLAB_BASE_URL).replace(/\/+$/, "");
  const apiRoot = `${baseUrl}/api/v4`;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const headers: Record<string, string> = {
        "PRIVATE-TOKEN": opts.token,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchImpl(`${apiRoot}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = gitlabErrorText(text, res.statusText);
        if (opts.token.length > 0)
          message = message.split(opts.token).join("[redacted]");
        if (message.length > GITLAB_MESSAGE_LIMIT)
          message = `${message.slice(0, GITLAB_MESSAGE_LIMIT)}...`;
        throw new GitLabApiError(res.status, message);
      }
      if (res.status === 204)
        return { status: res.status, data: undefined as T };
      return { status: res.status, data: (await res.json()) as T };
    },
  };
}

/** The workspace's GitLab main project, as its binding recorded it. */
export interface GitLabSteeringConnection {
  connectionId: string;
  projectId: string;
  owner: string;
  repo: string;
  approvedFullName: string;
  approvedDefaultRef: string;
}

/**
 * The workspace's GitLab main project, or null when there is none or when the
 * connection it was bound through is retired.
 *
 * Joined back to the connection for the reason the GitHub reader gives: the
 * binding rows outlive a revoked connection, and steering must stop at the
 * revoke rather than when the purge runs. There is no legacy fallback: GitLab
 * support starts with bindings.
 */
export async function readGitLabConnection(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<GitLabSteeringConnection | null> {
  return withTenantDb(async (tx) => {
    const [bound] = await tx
      .select({
        connectionId: schema.repositoryBindingHeads.connectionId,
        projectId: schema.repositoryBindings.providerRepositoryId,
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
          eq(schema.repositoryBindingHeads.role, "main"),
          eq(schema.repositoryBindingHeads.provider, GITLAB_PROVIDER),
          eq(schema.sourceConnections.connectorId, GITLAB_PROVIDER),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, [
            ...RETIRED_CONNECTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    return bound ?? null;
  });
}

/**
 * Wrap a GitLab refusal as `conflict: gitlab_refused` with GitLab's message.
 * A `HandlerError` passes through, so a refusal this module already shaped
 * keeps its reason. GitLab's messages never carry the token: the client
 * sends it in a header and never echoes it.
 */
export function gitlabRefused(err: unknown): HandlerError {
  if (err instanceof HandlerError) return err;
  return new HandlerError({
    code: "conflict",
    reason: "gitlab_refused",
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The refusal for a token GitLab no longer accepts: revoked, expired, or
 * stripped of the project. It names the project and the repair, and nothing
 * about the token.
 */
export function gitlabCredentialRejected(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "gitlab_credential_rejected",
    message: `GitLab refused the project access token stored for ${fullName}. It was revoked, expired, or lost access to the project. Connect the project again with a new token.`,
  });
}

/** What the GitLab seam is built from; the tests pass fakes. */
export interface SteeringGitLabDeps {
  readConnection: typeof readGitLabConnection;
  resolveToken: (scope: {
    orgId: string;
    workspaceId: string;
    connectionId: string;
  }) => Promise<string>;
  client: (token: string) => GitLabClient;
  /** Waits between merge-status and rebase polls. */
  sleep: (ms: number) => Promise<void>;
  /** The plain REST caller; defaults to {@link gitlabRest}. */
  rest?: (token: string) => GitLabRest;
  /**
   * The Oxagen user a GitLab account id is linked to. Oxagen offers no GitLab
   * sign-in today, so this normally answers null and a GitLab approval counts
   * for nothing until one exists.
   */
  linkAccount?: (
    providerId: string,
    accountId: string,
  ) => Promise<string | null>;
}

const defaultDeps: SteeringGitLabDeps = {
  readConnection: readGitLabConnection,
  resolveToken: async (scope) => (await resolveGitLabCredential(scope)).token,
  client: (token) => createGitLabClient({ token }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isStatus(err: unknown, status: number): boolean {
  return err instanceof GitLabApiError && err.status === status;
}

function describeStatus(title: string, summary: string): string {
  const text = summary ? `${title}: ${summary}` : title;
  return text.length <= STATUS_DESCRIPTION_LIMIT
    ? text
    : `${text.slice(0, STATUS_DESCRIPTION_LIMIT - 1)}…`;
}

/** One diff version of a merge request: the head it showed, and when. */
interface DiffVersion {
  sha: string;
  at: number;
}

/**
 * A merge request's diff versions, newest first. GitLab records a version
 * each time the source branch moves, stamped by its own clock. A version with
 * no head or no readable time is left out.
 */
async function diffVersions(
  rest: GitLabRest,
  projectPath: string,
  iid: number,
): Promise<DiffVersion[]> {
  const out = await rest.request<
    { head_commit_sha?: string | null; created_at?: string | null }[]
  >("GET", `${projectPath}/merge_requests/${iid}/versions?per_page=100`);
  return (Array.isArray(out.data) ? out.data : [])
    .flatMap((v) => {
      const at = Date.parse(v.created_at ?? "");
      return v.head_commit_sha && !Number.isNaN(at)
        ? [{ sha: v.head_commit_sha, at }]
        : [];
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * Refuse a merge when the project keeps approvals across a push. The merge
 * places each approval on the diff version it followed (`listApprovals`), and
 * this setting is a second guard: a project that keeps every approval on
 * every push is refused with `approvals_not_head_bound`, and so is one whose
 * setting GitLab will not show (403, or 404 on a tier without it). Any other
 * failure, such as a 429 or a 5xx, escapes, so the caller reports GitLab's
 * error and a retry can pass. A rejected token escapes as a 401, so the
 * caller names the token.
 */
async function requireApprovalsResetOnPush(
  rest: GitLabRest,
  projectPath: string,
  fullName: string,
): Promise<void> {
  let reset: boolean | null | undefined;
  try {
    const out = await rest.request<{
      reset_approvals_on_push?: boolean | null;
    }>("GET", `${projectPath}/approvals`);
    reset = out.data.reset_approvals_on_push;
  } catch (err) {
    if (!isStatus(err, 403) && !isStatus(err, 404)) throw err;
    reset = null;
  }
  if (reset === true) return;
  const fix = `Turn on "Reset approvals on push" (Settings > Merge requests > Approval settings, where GitLab labels it "Remove all approvals when commits are added to the source branch").`;
  throw new HandlerError({
    code: "conflict",
    reason: "approvals_not_head_bound",
    message:
      reset === false
        ? `GitLab keeps approvals on ${fullName} after a push, so an approval may not cover the head Oxagen merges. ${fix}`
        : `GitLab did not say whether ${fullName} resets approvals on push, so an approval may not cover the head Oxagen merges. ${fix} The setting needs GitLab Premium.`,
  });
}

function asPullRequest(mr: GitLabMergeRequest) {
  return {
    baseRef: mr.targetBranch,
    headSha: mr.sha,
    // GitLab holds a merge request `locked` while it merges it. That is not
    // closed, and reading it as closed would reject a proposal mid-merge.
    open: mr.state === "opened" || mr.state === "locked",
    merged: mr.state === "merged",
    // With a squash into a merge-commit project GitLab reports both; the merge
    // commit is the one on the production branch. A fast-forward project has
    // no merge commit, and the squash commit is what landed.
    mergeCommitSha: mr.mergeCommitSha ?? mr.squashCommitSha,
    mergedAt: mr.mergedAt ? new Date(mr.mergedAt) : null,
  };
}

export function createSteeringGitLab(
  deps: SteeringGitLabDeps = defaultDeps,
): SteeringHost {
  // Keyed by the handle `resolveRepository` returned, as in the GitHub seam:
  // a client built with one workspace's token serves only that handle.
  const clients = new WeakMap<SteeringRepository, GitLabClient>();
  const rests = new WeakMap<SteeringRepository, GitLabRest>();
  const makeRest = deps.rest ?? ((token: string) => gitlabRest({ token }));
  const linkAccount = deps.linkAccount ?? linkedOxagenUser;
  const handle = (
    repo: SteeringRepository,
  ): { gl: GitLabClient; project: string } => {
    const gl = clients.get(repo);
    if (!gl || repo.provider !== "gitlab")
      throw new Error(
        `[context.steering] no GitLab client for ${repo.fullName}`,
      );
    return { gl, project: repo.projectId };
  };

  /** Run one GitLab call, turning a rejected token into its own refusal. */
  const call = async <T>(
    repo: SteeringRepository,
    fn: (gl: GitLabClient, project: string) => Promise<T>,
  ): Promise<T> => {
    const { gl, project } = handle(repo);
    try {
      return await fn(gl, project);
    } catch (err) {
      if (isStatus(err, 401)) throw gitlabCredentialRejected(repo.fullName);
      throw gitlabRefused(err);
    }
  };

  /** Run one plain REST call under the same refusals as {@link call}. */
  const callRest = async <T>(
    repo: SteeringRepository,
    fn: (
      rest: GitLabRest,
      projectPath: string,
      gl: GitLabClient,
      project: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const { gl, project } = handle(repo);
    const rest = rests.get(repo);
    if (!rest)
      throw new Error(
        `[context.steering] no GitLab client for ${repo.fullName}`,
      );
    try {
      return await fn(
        rest,
        `/projects/${encodeURIComponent(project)}`,
        gl,
        project,
      );
    } catch (err) {
      if (isStatus(err, 401)) throw gitlabCredentialRejected(repo.fullName);
      throw gitlabRefused(err);
    }
  };

  return {
    async resolveRepository(scope) {
      const connection = await deps.readConnection(scope);
      if (!connection) {
        throw new HandlerError({
          code: "not_found",
          reason: "workspace_repository_missing",
          message:
            "This workspace has no connected GitLab project; a Context PR needs the main repository (MC spec §10.1)",
        });
      }
      const token = await deps.resolveToken({
        ...scope,
        connectionId: connection.connectionId,
      });
      const gl = deps.client(token);
      let project;
      try {
        project = await gl.getProject(connection.projectId);
      } catch (err) {
        if (isStatus(err, 401))
          throw gitlabCredentialRejected(connection.approvedFullName);
        if (isStatus(err, 404))
          throw new HandlerError({
            code: "not_found",
            reason: "repository_unreachable",
            message: `GitLab project ${connection.approvedFullName} (id ${connection.projectId}) is not visible to the stored token. It was deleted, or the token lost access to it.`,
          });
        throw gitlabRefused(err);
      }
      if (project.archived) {
        throw new HandlerError({
          code: "conflict",
          reason: "repository_archived",
          message: `GitLab project ${project.pathWithNamespace} is archived and read-only; unarchive it before publishing steering.`,
        });
      }
      if (project.pathWithNamespace !== connection.approvedFullName) {
        // A move or rename since the bind. Records stay stamped with the
        // approved name, and calls keep working because they use the id.
        logger.warn(
          {
            approvedFullName: connection.approvedFullName,
            currentFullName: project.pathWithNamespace,
            projectId: connection.projectId,
          },
          "context.steering: the GitLab project moved since it was bound; records stay stamped with the approved name",
        );
      }
      const repo: GitLabRepository = {
        provider: "gitlab",
        projectId: connection.projectId,
        owner: connection.owner,
        repo: connection.repo,
        fullName: connection.approvedFullName,
        currentFullName: project.pathWithNamespace,
        // The approved ref, never GitLab's current default branch; see the
        // `defaultBranch` field.
        defaultBranch: connection.approvedDefaultRef,
      };
      clients.set(repo, gl);
      rests.set(repo, makeRest(token));
      return repo;
    },

    readFile(repo, path, ref) {
      return call(repo, (gl, project) => gl.getFileRaw({ project, path, ref }));
    },

    lastCommitForPath(repo, path, ref) {
      return call(repo, async (gl, project) => {
        const [commit] = await gl.listPathCommits({
          project,
          path,
          ref,
          limit: 1,
        });
        return commit
          ? {
              sha: commit.sha,
              authorName: commit.authorName,
              // GitLab does not match a commit to an account in this API.
              authorLogin: null,
              committedAt: commit.committedAt,
              summary: commit.summary,
            }
          : null;
      });
    },

    ensureBranch(repo, branch, fromBranch, options) {
      return call(repo, async (gl, project) => {
        try {
          await gl.createBranch({
            project,
            branch,
            ref: options?.at ?? fromBranch,
          });
        } catch (err) {
          if (
            isStatus(err, 400) &&
            err instanceof Error &&
            /already exists/i.test(err.message)
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
          throw err;
        }
      });
    },

    reconcileFiles(repo, args) {
      return call(repo, async (gl, project) => {
        const paths = await gl.listTree({ project, ref: args.branch });
        const actions: GitLabCommitAction[] = paths
          .filter(
            (path) =>
              args.roots.some(
                (root) => path === root || path.startsWith(`${root}/`),
              ) && !args.files.includes(path),
          )
          .map((filePath) => ({ action: "delete", filePath }));
        // One commit for every removal, rather than GitHub's one per file:
        // the commits API takes a list of actions.
        if (actions.length > 0)
          await gl.commitFiles({
            project,
            branch: args.branch,
            message: `Remove omitted proposal files (${actions.length})`,
            actions,
          });
      });
    },

    putFile(repo, args) {
      return call(repo, async (gl, project) => {
        const existing = await gl.getFileRaw({
          project,
          path: args.path,
          ref: args.branch,
        });
        if (existing === args.content) {
          // GitLab refuses a commit that changes nothing. A retry that writes
          // the same file again answers the branch head, which already holds it.
          const branch = await gl.getBranch({ project, branch: args.branch });
          if (branch) return { commitSha: branch.commitSha };
        }
        const out = await gl.commitFiles({
          project,
          branch: args.branch,
          message: args.message,
          actions: [
            {
              action: existing === null ? "create" : "update",
              filePath: args.path,
              content: args.content,
            },
          ],
        });
        return { commitSha: out.sha };
      });
    },

    openPullRequest(repo, args) {
      return call(repo, async (gl, project) => {
        const mr = await gl.createMergeRequest({
          project,
          sourceBranch: args.head,
          targetBranch: args.base,
          title: args.title,
          description: args.body,
          ...(args.labels ? { labels: args.labels } : {}),
          // The merge handler deletes the branch itself, after it has read
          // the merge back, so GitLab must not remove it first.
          removeSourceBranch: false,
        });
        return { number: mr.iid, htmlUrl: mr.webUrl };
      });
    },

    updatePullRequest(repo, args) {
      return call(repo, async (gl, project) => {
        const mr = await gl.updateMergeRequest({
          project,
          iid: args.number,
          title: args.title,
          description: args.body,
        });
        return { number: mr.iid, htmlUrl: mr.webUrl };
      });
    },

    findOpenPullRequest(repo, args) {
      return call(repo, async (gl, project) => {
        const [mr] = await gl.listMergeRequests({
          project,
          sourceBranch: args.head,
          targetBranch: args.base,
          state: "opened",
        });
        return mr
          ? { number: mr.iid, htmlUrl: mr.webUrl, body: mr.description }
          : null;
      });
    },

    getPullRequest(repo, number) {
      return call(repo, async (gl, project) =>
        asPullRequest(await gl.getMergeRequest({ project, iid: number })),
      );
    },

    branchHead(repo, branch) {
      return call(repo, async (gl, project) => {
        const out = await gl.getBranch({ project, branch });
        return out?.commitSha ?? null;
      });
    },

    listFiles(repo, ref, dir) {
      return call(repo, async (gl, project) =>
        (await gl.listTree({ project, ref, path: dir })).filter((path) =>
          path.startsWith(`${dir}/`),
        ),
      );
    },

    changedPaths(repo, base, head) {
      return call(repo, async (gl, project) => {
        const diffs = await gl.compare({ project, from: base, to: head });
        refuseLongCompare(diffs.length, base, head);
        return [
          ...new Set(
            diffs.flatMap((d) =>
              d.oldPath !== d.newPath ? [d.oldPath, d.newPath] : [d.newPath],
            ),
          ),
        ];
      });
    },

    reportCheckRun(repo, args) {
      return call(repo, async (gl, project) => {
        try {
          const out = await gl.setCommitStatus({
            project,
            sha: args.headSha,
            state: args.conclusion === "success" ? "success" : "failed",
            name: args.name,
            description: describeStatus(args.title, args.summary),
          });
          return out.targetUrl;
        } catch (err) {
          // A token with a role below Developer cannot set statuses. The
          // outcome is on the proposal either way, and the merge gate reads
          // the proposal, as it does for a GitHub token without checks:write.
          if (isStatus(err, 403)) return null;
          throw err;
        }
      });
    },

    mergePullRequest(repo, args) {
      return call(repo, async (gl, project) => {
        // GitLab computes mergeability after every push. Merging while it is
        // still computing is refused, so wait for it, briefly.
        for (let attempt = 0; attempt < 10; attempt++) {
          const mr = await gl.getMergeRequest({ project, iid: args.number });
          if (!PENDING_MERGE_STATUSES.has(mr.detailedMergeStatus ?? "")) break;
          await deps.sleep(1000);
        }
        let merged: GitLabMergeRequest;
        try {
          merged = await gl.mergeMergeRequest({
            project,
            iid: args.number,
            sha: args.sha,
            squash: true,
            // GitLab takes the whole squash message in one field, so the
            // title and the trailer body travel together.
            squashCommitMessage:
              args.commitMessage === undefined
                ? args.commitTitle
                : `${args.commitTitle}\n\n${args.commitMessage}`,
            shouldRemoveSourceBranch: false,
          });
        } catch (err) {
          if (isStatus(err, 409))
            throw new HandlerError({
              code: "conflict",
              reason: "head_moved",
              message: `GitLab refused the merge: the merge request's head is no longer ${args.sha}. Run the checks again on the new head.`,
            });
          throw err;
        }
        const sha = merged.mergeCommitSha ?? merged.squashCommitSha;
        if (merged.state !== "merged" || !sha)
          throw new HandlerError({
            code: "conflict",
            reason: "gitlab_refused",
            message: `GitLab did not merge !${args.number} (state ${merged.state}); it may be waiting on a pipeline or an approval rule.`,
          });
        return { sha };
      });
    },

    closePullRequest(repo, number) {
      return call(repo, async (gl, project) => {
        await gl.updateMergeRequest({
          project,
          iid: number,
          stateEvent: "close",
        });
      });
    },

    deleteBranch(repo, branch) {
      return call(repo, async (gl, project) => {
        try {
          await gl.deleteBranch({ project, branch });
        } catch (err) {
          if (isStatus(err, 404)) return;
          throw err;
        }
      });
    },

    changedFiles(repo, base, head) {
      return call(repo, async (gl, project) => {
        const diffs = await gl.compare({ project, from: base, to: head });
        refuseLongCompare(diffs.length, base, head);
        return diffs.flatMap((d): SteeringChangedFile[] => {
          if (d.renamed && d.oldPath !== d.newPath)
            return [
              { path: d.oldPath, status: "removed" },
              { path: d.newPath, status: "added" },
            ];
          if (d.added) return [{ path: d.newPath, status: "added" }];
          if (d.deleted) return [{ path: d.oldPath, status: "removed" }];
          return [{ path: d.newPath, status: "modified" }];
        });
      });
    },

    commitFiles(repo, args) {
      return call(repo, async (gl, project) => {
        // GitLab's commits API takes no expected head, so the branch is read
        // first. A push that lands between this read and the commit is not
        // caught here; the merge, pinned to the stamped SHA, still refuses it.
        const branch = await gl.getBranch({ project, branch: args.branch });
        if (branch?.commitSha !== args.parent)
          throw new HandlerError({
            code: "conflict",
            reason: "head_moved",
            message: `The steering PR's branch ${args.branch} moved while Oxagen was merging it. Merge again to check the new head.`,
          });
        const actions: GitLabCommitAction[] = [];
        for (const file of args.files) {
          const existing = await gl.getFileRaw({
            project,
            path: file.path,
            ref: args.parent,
          });
          if (file.content === null) {
            if (existing !== null)
              actions.push({ action: "delete", filePath: file.path });
          } else if (existing !== file.content) {
            actions.push({
              action: existing === null ? "create" : "update",
              filePath: file.path,
              content: file.content,
            });
          }
        }
        // GitLab refuses a commit that changes nothing.
        if (actions.length === 0) return { sha: args.parent };
        return gl.commitFiles({
          project,
          branch: args.branch,
          message: args.message,
          actions,
        });
      });
    },

    holdsCommit(repo, head, ancestor) {
      if (head === ancestor) return Promise.resolve(true);
      return callRest(repo, async (rest, path) => {
        const out = await rest.request<{ id: string }>(
          "GET",
          `${path}/repository/merge_base?refs[]=${encodeURIComponent(head)}&refs[]=${encodeURIComponent(ancestor)}`,
        );
        return out.data.id === ancestor;
      });
    },

    updateBranch(repo, args) {
      return callRest(repo, async (rest, path, gl, project) => {
        const branch = await gl.getBranch({ project, branch: args.branch });
        if (branch?.commitSha !== args.expectedHead)
          throw new HandlerError({
            code: "conflict",
            reason: "head_moved",
            message: `The steering PR's branch ${args.branch} moved while Oxagen was merging it. Merge again to check the new head.`,
          });
        // GitLab brings a merge request up to date by rebasing it onto the
        // target branch as it is now, so it cannot pin `args.base`. The
        // rebase runs in the background, so poll it.
        await rest.request(
          "PUT",
          `${path}/merge_requests/${args.number}/rebase`,
        );
        for (let attempt = 0; attempt < REBASE_POLL_LIMIT; attempt++) {
          const mr = await rest.request<{
            rebase_in_progress?: boolean;
            merge_error?: string | null;
            sha: string | null;
          }>(
            "GET",
            `${path}/merge_requests/${args.number}?include_rebase_in_progress=true`,
          );
          if (!mr.data.rebase_in_progress) {
            if (mr.data.merge_error)
              throw new HandlerError({
                code: "conflict",
                reason: "update_conflict",
                message: `${repo.defaultBranch} does not rebase cleanly under ${args.branch}: ${mr.data.merge_error}. Resolve the conflict on the steering PR, then merge again.`,
              });
            // A rebase makes no merge commit, so it has no parents to answer.
            return { headSha: mr.data.sha ?? args.expectedHead, parents: null };
          }
          await deps.sleep(1000);
        }
        throw new HandlerError({
          code: "conflict",
          reason: "update_conflict",
          message: `GitLab was still rebasing ${args.branch} after ${REBASE_POLL_LIMIT} seconds. Merge again once the rebase finishes.`,
        });
      });
    },

    resetBranch(repo, branch, args) {
      // GitLab has no call that moves a branch backwards, so the branch is
      // deleted and created again at `to`. The merge request keeps its
      // source branch name and picks the branch up again. Neither call takes
      // an expected head, so the branch is read first: a branch that moved
      // off `from` is left alone.
      return call(repo, async (gl, project) => {
        const head = await gl.getBranch({ project, branch });
        if (head?.commitSha !== args.from) return false;
        await gl.deleteBranch({ project, branch });
        await gl.createBranch({ project, branch, ref: args.to });
        return true;
      });
    },

    listApprovals(repo, number) {
      return callRest(repo, async (rest, path, gl, project) => {
        // A project that keeps every approval on every push is refused first.
        await requireApprovalsResetOnPush(rest, path, repo.fullName);
        const out = await rest.request<{
          approved_by?: {
            user: { id: number; username: string } | null;
            approved_at?: string | null;
          }[];
        }>("GET", `${path}/merge_requests/${number}/approvals`);
        const approvals = (out.data.approved_by ?? []).flatMap((a) =>
          a.user ? [{ user: a.user, at: Date.parse(a.approved_at ?? "") }] : [],
        );
        if (approvals.length === 0) return [];
        // The head is read after the approvals. A push between the two reads
        // makes a head the merge queue never produced, so no approval of it
        // counts.
        const head = (await gl.getMergeRequest({ project, iid: number })).sha;
        if (!head)
          throw new HandlerError({
            code: "conflict",
            reason: "gitlab_refused",
            message: `GitLab did not report a head commit for !${number}. Merge again once GitLab shows the merge request's commits.`,
          });
        // GitLab does not say which head a reviewer approved, and it keeps
        // approvals across a push that leaves the diff's patch unchanged, as
        // the queue's own rebase does. So each approval is placed on the
        // newest diff version GitLab recorded strictly before it. A version
        // recorded at the same instant does not count as seen. An approval
        // with no time, or older than every version, is dropped. None is
        // given a null head, because the merge reads null as "any head".
        const versions = await diffVersions(rest, path, number);
        if (!versions.some((v) => v.sha === head))
          throw new HandlerError({
            code: "conflict",
            reason: "gitlab_refused",
            message: `GitLab has not recorded ${head} as a version of !${number} yet, so no approval can be placed on it. Merge again in a minute.`,
          });
        const placed = approvals.flatMap(({ user, at }) => {
          // A missing time parses to NaN, which no version precedes.
          const seen = versions.find((v) => v.at < at);
          return seen ? [{ user, commitSha: seen.sha }] : [];
        });
        return Promise.all(
          placed.map(async ({ user, commitSha }) => ({
            userId: await linkAccount(GITLAB_PROVIDER, String(user.id)),
            login: user.username,
            commitSha,
          })),
        );
      });
    },

    recordDeployment(repo, args) {
      return callRest(repo, async (rest, path) => {
        await rest.request("POST", `${path}/deployments`, {
          environment: args.environment,
          sha: args.sha,
          ref: args.ref,
          tag: false,
          status: "success",
        });
        // A GitLab deployment answers no page of its own.
        return { url: null };
      });
    },
  };
}
