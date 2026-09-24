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
  /** A commit anyone with push access makes on a branch. */
  commit(branch: string, path: string, content: string): string {
    const files = this.tree(branch);
    files.set(path, content);
    return this.addCommit(branch, files, `edit ${path}`);
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
    return sha;
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
