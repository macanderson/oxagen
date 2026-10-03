// An in-memory gitlab.com project for the GitLab steering tests (#3762). It
// keeps a commit graph, branches, merge requests and commit statuses, and it
// refuses what GitLab refuses: an existing branch, a create over an existing
// file, a commit that changes nothing, a second open merge request for one
// source and target, and a merge whose `sha` is no longer the head. Tests
// assert what reached GitLab through its fields, never through call shapes.
import {
  GitLabApiError,
  type GitLabClient,
  type GitLabCommitAction,
  type GitLabMergeRequest,
} from "@oxagen/gitlab";
import { gitBlobId } from "@oxagen/steering-bundle";
import type { GitLabRest, GitLabRestResponse } from "./context.steering.gitlab";

interface Commit {
  parent: string | null;
  files: Map<string, string>;
  message: string;
  at: string;
}

export const GITLAB_PROJECT = {
  id: "4242",
  pathWithNamespace: "acme/platform/rules",
  namespaceFullPath: "acme/platform",
  path: "rules",
  defaultBranch: "main",
  webUrl: "https://gitlab.com/acme/platform/rules",
  archived: false,
};

export class FakeGitLabApi {
  commits = new Map<string, Commit>();
  branches = new Map<string, string>();
  mergeRequests: (GitLabMergeRequest & { labels: readonly string[] })[] = [];
  statuses: {
    sha: string;
    name: string;
    state: string;
    description: string;
  }[] = [];
  merges: { iid: number; sha: string; squash: boolean; message?: string }[] =
    [];
  /** Every token the client was built with; the tests assert none leaks. */
  tokens: string[] = [];
  project = { ...GITLAB_PROJECT };
  /** Answer every call 401, as GitLab does for a revoked token. */
  revoked = false;
  /** Answer commit statuses 403, as for a Reporter-role token. */
  statusesRefused = false;
  /** How many reads of a new merge request report `checking` first. */
  checkingReads = 1;
  /** Every plain REST call, as `METHOD /route` under the project. */
  restCalls: string[] = [];
  /** Every rebase asked for, by merge request iid. */
  rebases: number[] = [];
  /** How many polls of each rebase report it still running. */
  rebasePolls = 1;
  /** Poll a rebase forever, as when GitLab's rebase worker is stuck. */
  rebaseStuck = false;
  /** The result of the last rebase of each merge request. */
  rebaseState = new Map<number, { polls: number; error: string | null }>();
  /**
   * The users GitLab reports as approving every merge request, and when. An
   * approval with no `at` is given the first time GitLab reports it. Null
   * reports no time at all.
   */
  approvedBy: { id: number; username: string; at?: string | null }[] = [
    { id: 501, username: "reviewer" },
  ];
  /**
   * The project's "Reset approvals on push" setting. When true, a push to an
   * open merge request's branch drops every approval. Null answers the read
   * 403, as a tier without approval settings does.
   */
  resetApprovalsOnPush: boolean | null = true;
  /** Fail the read of that setting with this status, such as 503. */
  approvalSettingsError: number | null = null;
  /**
   * Each merge request's diff versions, oldest first. GitLab records one when
   * the merge request opens and each time its source branch moves.
   */
  versions = new Map<number, { head: string; at: string }[]>();
  deployments: {
    environment: string;
    sha: string;
    ref: string;
    tag: boolean;
    status: string;
  }[] = [];
  /** Answer deployments 403, as for a Developer-role token. */
  deploymentsRefused = false;
  /** Every tag written through REST: its name, and the commit it names. */
  tags = new Map<string, string>();
  seq = 0;
  clock = Date.parse("2026-09-23T10:00:00.000Z");

  constructor(files: Record<string, string> = {}) {
    this.commits.set("c0", {
      parent: null,
      files: new Map(Object.entries(files)),
      message: "initial",
      at: this.tick(),
    });
    this.branches.set("main", "c0");
  }

  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  guard(project: unknown): void {
    if (this.revoked) throw new GitLabApiError(401, "401 Unauthorized");
    if (
      String(project) !== this.project.id &&
      project !== this.project.pathWithNamespace
    )
      throw new GitLabApiError(404, "404 Project Not Found");
  }
  sha(ref: string): string | undefined {
    return this.branches.get(ref) ?? (this.commits.has(ref) ? ref : undefined);
  }
  tree(ref: string): Map<string, string> {
    const sha = this.sha(ref);
    return new Map(sha ? this.commits.get(sha)!.files : []);
  }
  lineage(sha: string): string[] {
    const out: string[] = [];
    for (let s: string | null = sha; s; s = this.commits.get(s)!.parent)
      out.push(s);
    return out;
  }
  /** The newest commit both refs hold, or null when they share none. */
  mergeBase(a: string, b: string): string | null {
    const seen = new Set(this.lineage(a));
    return this.lineage(b).find((s) => seen.has(s)) ?? null;
  }
  /**
   * Rebase a merge request's branch onto its target, as GitLab's rebase
   * worker does: the branch's own changes land in one commit on top of the
   * target. A path both sides changed differently is a conflict, reported the
   * way GitLab reports it, as the merge request's `merge_error`.
   */
  rebase(iid: number): string | null {
    const mr = this.mr(iid);
    const head = this.branches.get(mr.sourceBranch)!;
    const target = this.branches.get(mr.targetBranch)!;
    const base = this.mergeBase(head, target);
    if (base === target) return null;
    const before = base
      ? this.commits.get(base)!.files
      : new Map<string, string>();
    const mine = this.commits.get(head)!.files;
    const files = new Map(this.commits.get(target)!.files);
    for (const path of new Set([...before.keys(), ...mine.keys()])) {
      const was = before.get(path);
      const now = mine.get(path);
      if (now === was) continue;
      const theirs = files.get(path);
      if (theirs !== was && theirs !== now)
        return `Rebase failed: conflict in ${path}`;
      if (now === undefined) files.delete(path);
      else files.set(path, now);
    }
    this.branches.set(mr.sourceBranch, target);
    this.addCommit(mr.sourceBranch, files, `rebase ${mr.sourceBranch}`);
    return null;
  }
  /**
   * A commit anyone with push access makes on a branch. A push to an open
   * merge request drops its approvals when the project resets them on push.
   * A rebase through the API keeps them, as GitLab does.
   */
  commit(branch: string, path: string, content: string): string {
    const files = this.tree(branch);
    files.set(path, content);
    const sha = this.addCommit(branch, files, `edit ${path}`);
    if (
      this.resetApprovalsOnPush === true &&
      this.mergeRequests.some(
        (m) => m.state === "opened" && m.sourceBranch === branch,
      )
    )
      this.approvedBy = [];
    return sha;
  }
  addCommit(
    branch: string,
    files: Map<string, string>,
    message: string,
  ): string {
    this.seq += 1;
    const sha = `gl${this.seq}`;
    this.commits.set(sha, {
      parent: this.branches.get(branch) ?? null,
      files,
      message,
      at: this.tick(),
    });
    this.branches.set(branch, sha);
    this.recordVersions(branch);
    return sha;
  }
  /** Record a new diff version on each open merge request from a branch. */
  recordVersions(branch: string): void {
    const head = this.branches.get(branch);
    if (!head) return;
    for (const mr of this.mergeRequests) {
      if (mr.state !== "opened" || mr.sourceBranch !== branch) continue;
      const seen = this.versions.get(mr.iid) ?? [];
      if (seen.at(-1)?.head === head) continue;
      this.versions.set(mr.iid, [...seen, { head, at: this.tick() }]);
    }
  }
  view(mr: (typeof this.mergeRequests)[number]): GitLabMergeRequest {
    const { labels: _labels, ...rest } = mr;
    return {
      ...rest,
      sha:
        mr.state === "opened"
          ? (this.branches.get(mr.sourceBranch) ?? null)
          : mr.sha,
    };
  }
  mr(iid: number) {
    const mr = this.mergeRequests.find((m) => m.iid === iid);
    if (!mr) throw new GitLabApiError(404, "404 Not found");
    return mr;
  }

  client(token: string): GitLabClient {
    this.tokens.push(token);
    return clientOver(this);
  }

  rest(token: string): GitLabRest {
    this.tokens.push(token);
    return restOver(this);
  }
}

/**
 * The plain REST calls the steering seam makes, answered from one fake
 * project: merge base, rebase and its poll, approval settings, approvals,
 * diff versions, and deployments.
 */
function restOver(api: FakeGitLabApi): GitLabRest {
  const answer = <T>(status: number, data: unknown): GitLabRestResponse<T> => ({
    status,
    data: data as T,
  });
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const url = new URL(path, "https://gitlab.test");
      const [, root, project, ...rest] = url.pathname.split("/");
      if (root !== "projects") throw new GitLabApiError(404, "404 Not Found");
      api.guard(decodeURIComponent(project ?? ""));
      const route = `${method} /${rest.join("/")}`;
      api.restCalls.push(route);
      const mrRoute =
        /^(GET|PUT) \/merge_requests\/(\d+)(\/rebase|\/approvals|\/versions)?$/.exec(
          route,
        );
      if (route === "GET /repository/merge_base") {
        const [a, b] = url.searchParams
          .getAll("refs[]")
          .map((r) => api.sha(r));
        const id = a && b ? api.mergeBase(a, b) : null;
        if (!id) throw new GitLabApiError(400, "Could not find merge base");
        return answer<T>(200, { id });
      }
      if (route === "GET /repository/tree") {
        const sha = api.sha(url.searchParams.get("ref") ?? "");
        if (!sha) throw new GitLabApiError(404, "404 Tree Not Found");
        const entries = [...api.tree(sha)].flatMap(([path, content]) => {
          // GitLab lists each directory as its own `tree` entry.
          const dirs = path
            .split("/")
            .slice(0, -1)
            .map((_, i, parts) => parts.slice(0, i + 1).join("/"));
          return [
            ...dirs.map((dir) => ({ id: `tree:${dir}`, path: dir, type: "tree" })),
            { id: gitBlobId(content), path, type: "blob" },
          ];
        });
        const unique = [
          ...new Map(entries.map((entry) => [entry.path, entry])).values(),
        ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const size = Number(url.searchParams.get("per_page") ?? 20);
        const page = Number(url.searchParams.get("page") ?? 1);
        return answer<T>(200, unique.slice((page - 1) * size, page * size));
      }
      if (route === "POST /repository/tags") {
        const { tag_name: name, ref } = body as { tag_name: string; ref: string };
        if (api.tags.has(name))
          throw new GitLabApiError(400, `Tag ${name} already exists`);
        const sha = api.sha(ref);
        if (!sha) throw new GitLabApiError(400, "Target is invalid");
        api.tags.set(name, sha);
        return answer<T>(201, { name, commit: { id: sha } });
      }
      const commitRoute = /^GET \/repository\/commits\/([^/]+)$/.exec(route);
      if (commitRoute) {
        const sha = decodeURIComponent(commitRoute[1]!);
        const commit = api.commits.get(sha);
        if (!commit) throw new GitLabApiError(404, "404 Commit Not Found");
        return answer<T>(200, {
          id: sha,
          parent_ids: commit.parent === null ? [] : [commit.parent],
        });
      }
      const tagRoute = /^GET \/repository\/tags\/(.+)$/.exec(route);
      if (tagRoute) {
        const name = decodeURIComponent(tagRoute[1]!);
        const sha = api.tags.get(name);
        if (!sha) throw new GitLabApiError(404, "404 Tag Not Found");
        return answer<T>(200, { name, commit: { id: sha } });
      }
      if (route === "GET /approvals") {
        if (api.approvalSettingsError !== null)
          throw new GitLabApiError(
            api.approvalSettingsError,
            `${api.approvalSettingsError} GitLab failed`,
          );
        if (api.resetApprovalsOnPush === null)
          throw new GitLabApiError(403, "403 Forbidden");
        return answer<T>(200, {
          reset_approvals_on_push: api.resetApprovalsOnPush,
        });
      }
      if (route === "POST /deployments") {
        if (api.deploymentsRefused)
          throw new GitLabApiError(403, "403 Forbidden");
        api.deployments.push(body as (typeof api.deployments)[number]);
        return answer<T>(201, { id: api.deployments.length });
      }
      if (mrRoute) {
        const iid = Number(mrRoute[2]);
        const mr = api.mr(iid);
        if (mrRoute[1] === "PUT" && mrRoute[3] === "/rebase") {
          api.rebases.push(iid);
          api.rebaseState.set(iid, {
            polls: api.rebasePolls,
            error: api.rebase(iid),
          });
          return answer<T>(202, { rebase_in_progress: true });
        }
        if (mrRoute[1] === "GET" && mrRoute[3] === "/approvals")
          return answer<T>(200, {
            approved_by: api.approvedBy.map((a) => {
              if (a.at === undefined) a.at = api.tick();
              return {
                user: { id: a.id, username: a.username },
                approved_at: a.at,
              };
            }),
          });
        if (mrRoute[1] === "GET" && mrRoute[3] === "/versions")
          return answer<T>(
            200,
            [...(api.versions.get(iid) ?? [])].reverse().map((v) => ({
              head_commit_sha: v.head,
              created_at: v.at,
            })),
          );
        if (mrRoute[1] === "GET" && mrRoute[3] === undefined) {
          const state = api.rebaseState.get(iid) ?? { polls: 0, error: null };
          const running = api.rebaseStuck || state.polls > 0;
          if (state.polls > 0) state.polls -= 1;
          return answer<T>(200, {
            rebase_in_progress: running,
            merge_error: running ? null : state.error,
            sha: api.branches.get(mr.sourceBranch) ?? null,
          });
        }
      }
      throw new GitLabApiError(404, `404 No fake route for ${route}`);
    },
  };
}

/** The GitLab client surface, answered from one fake project. */
function clientOver(api: FakeGitLabApi): GitLabClient {
  {
    return {
      async getProject(project) {
        api.guard(project);
        return { ...api.project };
      },
      async getCurrentToken() {
        api.guard(api.project.id);
        return {
          id: 1,
          name: "oxagen",
          scopes: ["api"],
          active: true,
          revoked: false,
          expiresAt: "2027-09-23",
        };
      },
      async getCurrentUser() {
        api.guard(api.project.id);
        return {
          id: 77,
          username: `project_${api.project.id}_bot_abc`,
          bot: true,
        };
      },
      async getFileRaw({ project, path, ref }) {
        api.guard(project);
        return api.tree(ref).get(path) ?? null;
      },
      async getBranch({ project, branch }) {
        api.guard(project);
        const sha = api.branches.get(branch);
        return sha ? { name: branch, commitSha: sha } : null;
      },
      async listPathCommits({ project, path, ref, limit }) {
        api.guard(project);
        const head = api.sha(ref);
        if (!head) return [];
        const out = [];
        for (const sha of api.lineage(head)) {
          const c = api.commits.get(sha)!;
          const before = c.parent
            ? api.commits.get(c.parent)!.files.get(path)
            : undefined;
          if (c.files.get(path) !== before)
            out.push({
              sha,
              authorName: "Oxagen Bot",
              authorEmail: null,
              committedAt: c.at,
              summary: c.message.split("\n")[0]!,
              message: c.message,
            });
          if (out.length >= limit) break;
        }
        return out;
      },
      async createBranch({ project, branch, ref }) {
        api.guard(project);
        if (api.branches.has(branch))
          throw new GitLabApiError(400, "Branch already exists");
        const sha = api.sha(ref);
        if (!sha) throw new GitLabApiError(400, "Invalid reference name");
        api.branches.set(branch, sha);
        api.recordVersions(branch);
      },
      async deleteBranch({ project, branch }) {
        api.guard(project);
        if (!api.branches.delete(branch))
          throw new GitLabApiError(404, "404 Branch Not Found");
      },
      async listTree({ project, ref }) {
        api.guard(project);
        return [...api.tree(ref).keys()];
      },
      async commitFiles({ project, branch, message, actions }) {
        api.guard(project);
        const files = api.tree(branch);
        const before = JSON.stringify([...files]);
        for (const a of actions as GitLabCommitAction[]) {
          const exists = files.has(a.filePath);
          if (a.action === "create" && exists)
            throw new GitLabApiError(
              400,
              "A file with this name already exists",
            );
          if (a.action !== "create" && !exists)
            throw new GitLabApiError(
              400,
              "A file with this name doesn't exist",
            );
          if (a.action === "delete") files.delete(a.filePath);
          else files.set(a.filePath, a.content);
        }
        if (JSON.stringify([...files]) === before)
          throw new GitLabApiError(400, "No changes to commit");
        return { sha: api.addCommit(branch, files, message) };
      },
      async compare({ project, from, to }) {
        api.guard(project);
        const a = api.tree(from);
        const b = api.tree(to);
        const out = [];
        for (const path of new Set([...a.keys(), ...b.keys()]))
          if (a.get(path) !== b.get(path))
            out.push({
              oldPath: path,
              newPath: path,
              renamed: false,
              deleted: !b.has(path),
              added: !a.has(path),
            });
        return out;
      },
      // The steering fake changes files whole and keeps no hunks, so a
      // compare's diff text is empty and says so.
      async compareDiff({ project }) {
        api.guard(project);
        return {
          text: "",
          files: [],
          complete: false,
          limitations: ["file_without_hunks"],
        };
      },
      async createMergeRequest(a) {
        api.guard(a.project);
        if (
          api.mergeRequests.some(
            (m) =>
              m.state === "opened" &&
              m.sourceBranch === a.sourceBranch &&
              m.targetBranch === a.targetBranch,
          )
        )
          throw new GitLabApiError(
            409,
            "Another open merge request already exists",
          );
        const iid = api.mergeRequests.length + 1;
        const mr = {
          iid,
          webUrl: `${api.project.webUrl}/-/merge_requests/${iid}`,
          title: a.title,
          description: a.description,
          state: "opened" as const,
          sourceBranch: a.sourceBranch,
          targetBranch: a.targetBranch,
          sha: null,
          mergeCommitSha: null,
          squashCommitSha: null,
          mergedAt: null,
          detailedMergeStatus: "checking",
          projectId: api.project.id,
          labels: a.labels ?? [],
        };
        api.mergeRequests.push(mr);
        api.recordVersions(a.sourceBranch);
        return api.view(mr);
      },
      async updateMergeRequest({
        project,
        iid,
        title,
        description,
        stateEvent,
      }) {
        api.guard(project);
        const mr = api.mr(iid);
        if (title !== undefined) mr.title = title;
        if (description !== undefined) mr.description = description;
        if (stateEvent === "close") {
          mr.sha = api.branches.get(mr.sourceBranch) ?? mr.sha;
          (mr as { state: string }).state = "closed";
        }
        return api.view(mr);
      },
      async listMergeRequests({ project, sourceBranch, targetBranch, state }) {
        api.guard(project);
        return api.mergeRequests
          .filter(
            (m) =>
              m.sourceBranch === sourceBranch &&
              m.targetBranch === targetBranch &&
              (state === "all" || m.state === state),
          )
          .map((m) => api.view(m));
      },
      async getMergeRequest({ project, iid }) {
        api.guard(project);
        const mr = api.mr(iid);
        if (mr.state === "opened") {
          if (api.checkingReads > 0) {
            api.checkingReads -= 1;
            mr.detailedMergeStatus = "checking";
          } else mr.detailedMergeStatus = "mergeable";
        }
        return api.view(mr);
      },
      async mergeMergeRequest({
        project,
        iid,
        sha,
        squash,
        squashCommitMessage,
      }) {
        api.guard(project);
        const mr = api.mr(iid);
        const head = api.branches.get(mr.sourceBranch);
        if (mr.state !== "opened")
          throw new GitLabApiError(405, "Method Not Allowed");
        if (head !== sha)
          throw new GitLabApiError(
            409,
            "SHA does not match HEAD of source branch",
          );
        // A fast-forward project: the squash commit is what lands, and GitLab
        // reports no merge commit.
        const landed = api.addCommit(
          mr.targetBranch,
          new Map(api.commits.get(head)!.files),
          squashCommitMessage ?? mr.title,
        );
        api.merges.push({ iid, sha, squash, message: squashCommitMessage });
        Object.assign(mr, {
          state: "merged",
          sha: head,
          squashCommitSha: landed,
          mergeCommitSha: null,
          mergedAt: api.commits.get(landed)!.at,
        });
        return api.view(mr);
      },
      async setCommitStatus({ project, sha, state, name, description }) {
        api.guard(project);
        if (api.statusesRefused) throw new GitLabApiError(403, "403 Forbidden");
        api.statuses.push({ sha, name, state, description: description ?? "" });
        return { id: api.statuses.length, targetUrl: null };
      },
      async createProjectHook({ project, url }) {
        api.guard(project);
        return { id: 901, url };
      },
      async deleteProjectHook({ project }) {
        api.guard(project);
      },
    };
  }
}
