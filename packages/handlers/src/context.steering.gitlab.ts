// context.steering.gitlab.ts — the GitLab implementation of the steering port
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
//   the commit the checks ran on — the same guarantee GitHub gives.
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
import type {
  SteeringHost,
  SteeringRepository,
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
  /** Waits between merge-status polls. */
  sleep: (ms: number) => Promise<void>;
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

function asPullRequest(mr: GitLabMergeRequest) {
  return {
    baseRef: mr.targetBranch,
    headSha: mr.sha,
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
      const gl = deps.client(
        await deps.resolveToken({
          ...scope,
          connectionId: connection.connectionId,
        }),
      );
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
          await gl.createBranch({ project, branch, ref: fromBranch });
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

    changedPaths(repo, base, head) {
      return call(repo, async (gl, project) => {
        const diffs = await gl.compare({ project, from: base, to: head });
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
            squashCommitMessage: args.commitTitle,
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
  };
}
