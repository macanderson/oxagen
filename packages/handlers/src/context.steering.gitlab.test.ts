// The GitLab steering seam (#3762), against an in-memory gitlab.com project.
//
// The first block runs the real handlers end to end: a proposal becomes a
// merge request on the GitLab project, its six checks become one commit status,
// and a reviewer's merge squashes the checked head and publishes the record.
// The rest pins the seam's GitLab-specific behaviour one call at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId || gate.refuse)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    return "Member";
  },
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("./logger", () => ({
  logger: { warn: log.warn, info: log.info, error: vi.fn(), debug: vi.fn() },
}));

import { createOpenContextPrHandler } from "./context.pr.open";
import { createMergeContextPrHandler } from "./context.pr.merge";
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import { createProposeRecordHandler } from "./context.proposal.create";
import type {
  SteeringHost,
  SteeringRepository,
} from "./context.steering.github";
import {
  createSteeringGitLab,
  gitlabRest,
  type GitLabSteeringConnection,
} from "./context.steering.gitlab";
import { createSteeringHost } from "./context.steering.host";
import {
  FakeGitLabApi,
  GITLAB_PROJECT,
} from "./context.steering.gitlab.test-support";
import {
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const TOKEN = "glpat-stored-token-never-shown";
const LINEAGE = "ctx.release.no-reread-changelog";
const PATH = `.oxagen/rules/${LINEAGE}.toml`;
const BRANCH = `steering/${LINEAGE}`;

const CONNECTION: GitLabSteeringConnection = {
  connectionId: "0192d4a8-7c1e-7a00-8000-00000000c011",
  projectId: GITLAB_PROJECT.id,
  owner: GITLAB_PROJECT.namespaceFullPath,
  repo: GITLAB_PROJECT.path,
  approvedFullName: GITLAB_PROJECT.pathWithNamespace,
  approvedDefaultRef: "main",
};

function gitlabSeam(
  api: FakeGitLabApi,
  connection: GitLabSteeringConnection | null = CONNECTION,
) {
  const resolveToken = vi.fn(async () => TOKEN);
  const sleep = vi.fn(async () => {});
  // GitLab user 501 is the fake's approving reviewer, linked to REVIEWER.
  const linkAccount = vi.fn(async (_provider: string, id: string) =>
    id === "501" ? REVIEWER : null,
  );
  const seam = createSteeringGitLab({
    readConnection: async () => connection,
    resolveToken,
    client: (token) => api.client(token),
    rest: (token) => api.rest(token),
    linkAccount,
    sleep,
  });
  return { seam, resolveToken, sleep, linkAccount };
}

/** A GitHub seam that fails the test if the host ever routes a call to it. */
const NO_GITHUB = new Proxy({} as SteeringHost, {
  get: (_t, name) => () => {
    throw new Error(
      `GitHub was asked to ${String(name)} for a GitLab workspace`,
    );
  },
});

/**
 * The steering harness with its GitHub fake swapped for the host dispatcher,
 * whose workspace is bound to the GitLab project.
 */
function gitlabHarness(files: Record<string, string> = {}) {
  const api = new FakeGitLabApi(files);
  const { seam } = gitlabSeam(api);
  const h = harness();
  const host = createSteeringHost({
    mainProvider: async () => "gitlab",
    github: NO_GITHUB,
    gitlab: seam,
  });
  return { api, h: { ...h, github: host } as unknown as Harness };
}

async function propose(h: Harness) {
  const input = contextProposalCreate.input.parse({
    record: {
      lineageId: LINEAGE,
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      statement:
        "Do not re-read CHANGELOG.md more than once in a run; cache the first read.",
    },
    rationale: "682 duplicate tool calls across 212 runs.",
    support: {
      runs: ["run_1"],
      agents: ["a-intel.core.cc"],
      recordIds: [],
      evidenceLinks: [],
    },
  });
  return (await createProposeRecordHandler(h)(input, ctx())).proposalId;
}

beforeEach(() => {
  gate.refuse = false;
  log.warn.mockClear();
});

describe("a context record published through a GitLab merge request", () => {
  it("opens a merge request, reports one commit status for the six checks, then squash-merges the checked head and publishes", async () => {
    const { api, h } = gitlabHarness();
    const proposalId = await propose(h);

    const opened = await createOpenContextPrHandler(h)({ proposalId }, ctx());

    expect(opened.status).toBe("checks_passed");
    expect(opened.pr).toMatchObject({
      number: 1,
      provider: "gitlab",
      url: "https://gitlab.com/acme/platform/rules/-/merge_requests/1",
      repository: "acme/platform/rules",
      baseRef: "main",
      branch: BRANCH,
    });
    const [mr] = api.mergeRequests;
    expect(mr).toMatchObject({
      sourceBranch: BRANCH,
      targetBranch: "main",
      title: `Context PR: ${LINEAGE}`,
    });
    expect(mr!.description).toContain(proposalId);
    const head = api.branches.get(BRANCH)!;
    expect(opened.pr!.headSha).toBe(head);
    // One required status carries all six outcomes.
    expect(api.statuses).toEqual([
      expect.objectContaining({
        sha: head,
        name: "Oxagen steering",
        state: "success",
      }),
    ]);
    // The record's set id is the approved project path, dotted.
    const file = api.commits.get(head)!.files.get(PATH)!;
    expect(file).toContain('set_id = "acme.platform.rules"');
    expect(h.store.proposals[0]).toMatchObject({
      provider: "gitlab",
      prNumber: 1,
    });

    const merged = await createMergeContextPrHandler(h)(
      { proposalId },
      ctx({ userId: REVIEWER }),
    );

    expect(merged.status).toBe("merged");
    expect(api.merges).toEqual([
      {
        iid: 1,
        sha: head,
        squash: true,
        // GitLab takes the squash title and the trailers in one message.
        message: [
          `steering: publish ${LINEAGE} (#1)`,
          "",
          `Oxagen-Approved-By: ${REVIEWER}`,
          "Oxagen-Checks: schema,lineage_uniqueness,record_hash,secret_pii_scan,conflict_against_active,constraint_effect",
          "Oxagen-Version: 1",
        ].join("\n"),
      },
    ]);
    // The squash commit is what landed on main, and the published record is
    // the file at the checked head.
    const landed = api.branches.get("main")!;
    expect(merged.mergedCommit).toBe(landed);
    expect(api.commits.get(landed)!.files.get(PATH)).toBe(file);
    expect(h.store.records).toHaveLength(1);
    expect(h.store.ledger).toHaveLength(1);
    expect(h.events.map((e) => e.eventType)).toContain("steering.published");
    expect(api.branches.has(BRANCH)).toBe(false);
    // Only the stored token reached GitLab.
    expect(new Set(api.tokens)).toEqual(new Set([TOKEN]));
  });

  it("refuses the merge when the merge request's head moved after the checks", async () => {
    const { api, h } = gitlabHarness();
    const proposalId = await propose(h);
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    api.commit(BRANCH, "README.md", "pushed after the checks\n");

    await expect(
      createMergeContextPrHandler(h)({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ code: "conflict", reason: "head_moved" });
    expect(api.merges).toHaveLength(0);
    expect(h.store.records).toHaveLength(0);
  });

  it.each([
    ["keeps approvals on push", false],
    ["will not say whether it resets approvals", null],
  ] as const)(
    "refuses the merge when the project %s, so no approval binds to the head",
    async (_case, reset) => {
      const { api, h } = gitlabHarness();
      const proposalId = await propose(h);
      await createOpenContextPrHandler(h)({ proposalId }, ctx());
      api.resetApprovalsOnPush = reset;

      await expect(
        createMergeContextPrHandler(h)(
          { proposalId },
          ctx({ userId: REVIEWER }),
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "approvals_not_head_bound",
      });
      expect(api.merges).toHaveLength(0);
      expect(h.store.records).toHaveLength(0);
    },
  );

  it("fails a check when the branch changes another file, so nothing merges", async () => {
    const { api, h } = gitlabHarness();
    const proposalId = await propose(h);
    const open = createOpenContextPrHandler(h);
    await open({ proposalId }, ctx());
    api.commit(BRANCH, ".oxagen/rules/governance.toml", 'mode = "solo"\n');

    const rerun = await open({ proposalId }, ctx());

    expect(rerun.status).toBe("checks_failed");
    const latest = api.branches.get(BRANCH)!;
    expect(
      api.statuses.some((s) => s.sha === latest && s.state === "failed"),
    ).toBe(true);
    await expect(
      createMergeContextPrHandler(h)({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ reason: "checks_not_passed" });
    expect(api.merges).toHaveLength(0);
  });

  it("closes the merge request and deletes the branch on dismiss", async () => {
    const { api, h } = gitlabHarness();
    const proposalId = await propose(h);
    await createOpenContextPrHandler(h)({ proposalId }, ctx());

    await createDismissProposalHandler(h)(
      { proposalId, reason: "superseded" },
      ctx(),
    );

    expect(api.mergeRequests[0]!.state).toBe("closed");
    expect(api.branches.has(BRANCH)).toBe(false);
  });

  it("refuses to read a GitHub PR number back through GitLab", async () => {
    const { h } = gitlabHarness();
    const proposalId = await propose(h);
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    // The row as a GitHub-era open would have left it.
    h.store.proposals[0]!.provider = "github";

    await expect(
      createMergeContextPrHandler(h)({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ reason: "repository_host_changed" });
    await expect(
      createOpenContextPrHandler(h)({ proposalId }, ctx()),
    ).rejects.toMatchObject({ reason: "repository_host_changed" });
  });
});

describe("a proposal whose PR was opened on the other host", () => {
  it("is dismissed without closing anything by its number on GitLab", async () => {
    const { api, h } = gitlabHarness();
    const proposalId = await propose(h);
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    // The row as a GitHub-era open left it: `!1` on GitLab is not its PR.
    h.store.proposals[0]!.provider = "github";

    const out = await createDismissProposalHandler(h)(
      { proposalId, reason: "moved to GitLab" },
      ctx(),
    );

    expect(out.status).toBe("rejected");
    expect(api.mergeRequests[0]!.state).toBe("opened");
    expect(api.branches.has(BRANCH)).toBe(true);
  });
});

describe("the GitLab seam", () => {
  const resolved = async (api: FakeGitLabApi) => {
    const { seam, sleep, resolveToken } = gitlabSeam(api);
    const repo = await seam.resolveRepository(SCOPE);
    return { seam, repo, sleep, resolveToken };
  };

  it("resolves the bound project by id, with the approved branch and name", async () => {
    const api = new FakeGitLabApi();
    const { repo, resolveToken } = await resolved(api);
    expect(repo).toEqual({
      provider: "gitlab",
      projectId: "4242",
      owner: "acme/platform",
      repo: "rules",
      fullName: "acme/platform/rules",
      currentFullName: "acme/platform/rules",
      defaultBranch: "main",
    });
    expect(resolveToken).toHaveBeenCalledWith({
      ...SCOPE,
      connectionId: CONNECTION.connectionId,
    });
  });

  it("keeps working, by id, after the project moves to another group, and says so", async () => {
    const api = new FakeGitLabApi();
    api.project.pathWithNamespace = "acme/governance/rules";
    const { repo } = await resolved(api);
    expect(repo.fullName).toBe("acme/platform/rules");
    expect(repo.currentFullName).toBe("acme/governance/rules");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ currentFullName: "acme/governance/rules" }),
      expect.stringContaining("moved"),
    );
  });

  it("refuses a workspace with no live GitLab binding", async () => {
    const { seam } = gitlabSeam(new FakeGitLabApi(), null);
    await expect(seam.resolveRepository(SCOPE)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_repository_missing",
    });
  });

  it("fails closed on a revoked token, naming the project and not the token", async () => {
    const api = new FakeGitLabApi();
    api.revoked = true;
    const { seam } = gitlabSeam(api);
    const err = await seam.resolveRepository(SCOPE).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "gitlab_credential_rejected",
    });
    expect((err as Error).message).toContain("acme/platform/rules");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("fails closed when the token is revoked mid-flow", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    api.revoked = true;
    await expect(seam.readFile(repo, "x", "main")).rejects.toMatchObject({
      reason: "gitlab_credential_rejected",
    });
  });

  it("refuses an archived project and a project the token cannot see", async () => {
    const archived = new FakeGitLabApi();
    archived.project.archived = true;
    await expect(
      gitlabSeam(archived).seam.resolveRepository(SCOPE),
    ).rejects.toMatchObject({ reason: "repository_archived" });

    const gone = new FakeGitLabApi();
    gone.project.id = "9999";
    await expect(
      gitlabSeam(gone).seam.resolveRepository(SCOPE),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_unreachable",
    });
  });

  it("reuses an existing branch, and refuses one when asked for an exclusive branch", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    await seam.ensureBranch(repo, "b", "main");
    await expect(seam.ensureBranch(repo, "b", "main")).resolves.toBeUndefined();
    await expect(
      seam.ensureBranch(repo, "b", "main", { exclusive: true }),
    ).rejects.toMatchObject({ reason: "proposal_branch_exists" });
  });

  it("creates a branch at the commit it is given, not at the base branch's head", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    const planned = api.branches.get("main")!;
    await seam.ensureBranch(repo, "other", "main");
    const { commitSha: moved } = await seam.putFile(repo, {
      path: "a.toml",
      content: "1",
      message: "m",
      branch: "other",
    });
    api.branches.set("main", moved);
    await seam.ensureBranch(repo, "b", "main", { exclusive: true, at: planned });
    expect(api.branches.get("b")).toBe(planned);
  });

  it("creates, updates, and answers the head for an identical write", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    await seam.ensureBranch(repo, "b", "main");
    const first = await seam.putFile(repo, {
      path: "a.toml",
      content: "1",
      message: "m",
      branch: "b",
    });
    const second = await seam.putFile(repo, {
      path: "a.toml",
      content: "2",
      message: "m",
      branch: "b",
    });
    const same = await seam.putFile(repo, {
      path: "a.toml",
      content: "2",
      message: "m",
      branch: "b",
    });
    expect(first.commitSha).not.toBe(second.commitSha);
    expect(same.commitSha).toBe(second.commitSha);
    expect(await seam.readFile(repo, "a.toml", "b")).toBe("2");
  });

  it("removes omitted files under the owned roots in one commit", async () => {
    const api = new FakeGitLabApi({
      ".oxagen/skills/demo/a.md": "a",
      ".oxagen/skills/demo/b.md": "b",
      ".oxagen/skills/other/c.md": "c",
    });
    const { seam, repo } = await resolved(api);
    await seam.ensureBranch(repo, "b", "main");
    const before = api.commits.size;
    await seam.reconcileFiles(repo, {
      branch: "b",
      roots: [".oxagen/skills/demo"],
      files: [".oxagen/skills/demo/a.md"],
    });
    expect(api.commits.size).toBe(before + 1);
    expect(
      await seam.readFile(repo, ".oxagen/skills/demo/b.md", "b"),
    ).toBeNull();
    expect(await seam.readFile(repo, ".oxagen/skills/other/c.md", "b")).toBe(
      "c",
    );
  });

  it("waits out GitLab's mergeability check before merging", async () => {
    const api = new FakeGitLabApi();
    api.checkingReads = 3;
    const { seam, repo, sleep } = await resolved(api);
    await seam.ensureBranch(repo, "b", "main");
    const { commitSha } = await seam.putFile(repo, {
      path: "a",
      content: "1",
      message: "m",
      branch: "b",
    });
    const mr = await seam.openPullRequest(repo, {
      title: "t",
      head: "b",
      base: "main",
      body: "",
    });
    const out = await seam.mergePullRequest(repo, {
      number: mr.number,
      commitTitle: "t",
      sha: commitSha,
    });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(out.sha).toBe(api.branches.get("main"));
  });

  async function openedMr(api: FakeGitLabApi) {
    const { seam, repo } = await resolved(api);
    await seam.ensureBranch(repo, "b", "main");
    const { commitSha } = await seam.putFile(repo, {
      path: "a",
      content: "1",
      message: "m",
      branch: "b",
    });
    const mr = await seam.openPullRequest(repo, {
      title: "t",
      head: "b",
      base: "main",
      body: "",
    });
    return { seam, repo, commitSha, mr };
  }

  it("refuses a merge whose head moved past the checked commit as head_moved", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo, commitSha, mr } = await openedMr(api);
    api.commit("b", "b", "pushed after the checks");
    await expect(
      seam.mergePullRequest(repo, {
        number: mr.number,
        commitTitle: "t",
        sha: commitSha,
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "head_moved" });
    expect(api.merges).toHaveLength(0);
  });

  it("refuses a merge GitLab accepted without merging, such as one waiting on a pipeline", async () => {
    const api = new FakeGitLabApi();
    const { repo, commitSha, mr } = await openedMr(api);
    const client = api.client.bind(api);
    api.client = (t) => ({
      ...client(t),
      mergeMergeRequest: async () => ({
        ...(await client(t).getMergeRequest({ project: "4242", iid: 1 })),
        state: "opened" as const,
      }),
    });
    const { seam } = gitlabSeam(api);
    const fresh = await seam.resolveRepository(SCOPE);
    await expect(
      seam.mergePullRequest(fresh, {
        number: mr.number,
        commitTitle: "t",
        sha: commitSha,
      }),
    ).rejects.toMatchObject({ reason: "gitlab_refused" });
    expect(repo.provider).toBe("gitlab");
  });

  it("updates a merge request's title and description by its IID", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo, mr } = await openedMr(api);
    await expect(
      seam.updatePullRequest(repo, {
        number: mr.number,
        title: "Context PR: renamed",
        body: "new body",
      }),
    ).resolves.toEqual({ number: 1, htmlUrl: mr.htmlUrl });
    expect(api.mergeRequests[0]).toMatchObject({
      title: "Context PR: renamed",
      description: "new body",
    });
  });

  it("wraps any other GitLab refusal as gitlab_refused with GitLab's message", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    await expect(
      seam.ensureBranch(repo, "b", "no-such-ref"),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "gitlab_refused",
      message: expect.stringContaining("Invalid reference name"),
    });
  });

  it("reports a refused commit status as no URL rather than failing the check", async () => {
    const api = new FakeGitLabApi();
    api.statusesRefused = true;
    const { seam, repo } = await resolved(api);
    await expect(
      seam.reportCheckRun(repo, {
        name: "Oxagen · Schema",
        headSha: "c0",
        conclusion: "success",
        title: "Schema",
        summary: "ok",
        startedAt: "",
        completedAt: "",
      }),
    ).resolves.toBeNull();
  });

  it("truncates a long status description to GitLab's limit", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    await seam.reportCheckRun(repo, {
      name: "Oxagen · Schema",
      headSha: "c0",
      conclusion: "failure",
      title: "Schema",
      summary: "x".repeat(400),
      startedAt: "",
      completedAt: "",
    });
    expect(api.statuses[0]!.description.length).toBe(255);
    expect(api.statuses[0]!.state).toBe("failed");
  });

  it("treats a branch already gone as deleted, and refuses a handle it did not resolve", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    await expect(seam.deleteBranch(repo, "never")).resolves.toBeUndefined();
    const forged = { ...repo } as SteeringRepository;
    await expect(seam.readFile(forged, "x", "main")).rejects.toThrow(
      "no GitLab client",
    );
  });

  it("reads provenance from the commit that last changed a path", async () => {
    const api = new FakeGitLabApi();
    const { seam, repo } = await resolved(api);
    const sha = api.commit("main", "r.toml", "1");
    api.commit("main", "other", "x");
    await expect(
      seam.lastCommitForPath(repo, "r.toml", "main"),
    ).resolves.toMatchObject({ sha, authorLogin: null });
    await expect(
      seam.lastCommitForPath(repo, "none", "main"),
    ).resolves.toBeNull();
  });
});

describe("the GitLab seam's merge-queue calls", () => {
  async function onBranch(files: Record<string, string> = { a: "0" }) {
    const api = new FakeGitLabApi(files);
    const { seam, sleep, linkAccount } = gitlabSeam(api);
    const repo = await seam.resolveRepository(SCOPE);
    await seam.ensureBranch(repo, "b", "main");
    const { commitSha } = await seam.putFile(repo, {
      path: "a",
      content: "1",
      message: "m",
      branch: "b",
    });
    const mr = await seam.openPullRequest(repo, {
      title: "t",
      head: "b",
      base: "main",
      body: "",
    });
    return { api, seam, repo, sleep, linkAccount, head: commitSha, mr };
  }

  it("lists what a branch changes, splitting a rename into a removal and an addition", async () => {
    const { api, seam, repo, head } = await onBranch({ a: "0", gone: "x" });
    api.commit("b", "new", "n");
    const files = new Map(api.tree("b"));
    files.delete("gone");
    const tip = api.addCommit("b", files, "remove gone");
    await expect(seam.changedFiles(repo, "c0", tip)).resolves.toEqual(
      expect.arrayContaining([
        { path: "a", status: "modified" },
        { path: "new", status: "added" },
        { path: "gone", status: "removed" },
      ]),
    );
    const client = api.client.bind(api);
    api.client = (t) => ({
      ...client(t),
      compare: async () => [
        {
          oldPath: "old.toml",
          newPath: "new.toml",
          renamed: true,
          deleted: false,
          added: false,
        },
      ],
    });
    const { seam: renaming } = gitlabSeam(api);
    const fresh = await renaming.resolveRepository(SCOPE);
    await expect(renaming.changedFiles(fresh, "c0", head)).resolves.toEqual([
      { path: "old.toml", status: "removed" },
      { path: "new.toml", status: "added" },
    ]);

    // The same 300-file refusal as GitHub, so both hosts refuse one change.
    api.client = (t) => ({
      ...client(t),
      compare: async () =>
        Array.from({ length: 300 }, (_, i) => ({
          oldPath: `r${i}.toml`,
          newPath: `r${i}.toml`,
          renamed: false,
          deleted: false,
          added: true,
        })),
    });
    const { seam: wide } = gitlabSeam(api);
    const wideRepo = await wide.resolveRepository(SCOPE);
    await expect(wide.changedFiles(wideRepo, "c0", head)).rejects.toMatchObject(
      { code: "conflict", reason: "too_many_files" },
    );
    await expect(wide.changedPaths(wideRepo, "c0", head)).rejects.toMatchObject(
      { reason: "too_many_files" },
    );
  });

  it("commits writes and deletions on the parent, skipping a file already at its content", async () => {
    const { api, seam, repo, head } = await onBranch({ a: "0", old: "x" });
    const out = await seam.commitFiles(repo, {
      branch: "b",
      parent: head,
      message: "stamp",
      files: [
        { path: "a", content: "1" },
        { path: "old", content: null },
        { path: "fresh", content: "f" },
        { path: "never", content: null },
      ],
    });
    expect(out.sha).toBe(api.branches.get("b"));
    expect(api.commits.get(out.sha)).toMatchObject({
      parent: head,
      message: "stamp",
    });
    expect(Object.fromEntries(api.tree(out.sha))).toEqual({
      a: "1",
      fresh: "f",
    });
  });

  it("answers the parent when a commit would change nothing", async () => {
    const { api, seam, repo, head } = await onBranch();
    await expect(
      seam.commitFiles(repo, {
        branch: "b",
        parent: head,
        message: "stamp",
        files: [{ path: "a", content: "1" }],
      }),
    ).resolves.toEqual({ sha: head });
    expect(api.branches.get("b")).toBe(head);
  });

  it("refuses a commit on a branch that moved past its parent as head_moved", async () => {
    const { api, seam, repo, head } = await onBranch();
    api.commit("b", "a", "pushed");
    await expect(
      seam.commitFiles(repo, {
        branch: "b",
        parent: head,
        message: "stamp",
        files: [{ path: "a", content: "2" }],
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "head_moved" });
  });

  it("says whether a head holds a commit, without a call when they are equal", async () => {
    const { api, seam, repo, head } = await onBranch();
    await expect(seam.holdsCommit(repo, head, head)).resolves.toBe(true);
    expect(api.restCalls).toEqual([]);
    await expect(seam.holdsCommit(repo, head, "c0")).resolves.toBe(true);
    const moved = api.commit("main", "z", "1");
    await expect(seam.holdsCommit(repo, head, moved)).resolves.toBe(false);
  });

  it("rebases the branch onto main and answers its new head once the rebase finishes", async () => {
    const { api, seam, repo, sleep, head, mr } = await onBranch();
    api.rebasePolls = 2;
    const main = api.commit("main", "z", "1");
    const out = await seam.updateBranch(repo, {
      number: mr.number,
      branch: "b",
      expectedHead: head,
      base: main,
    });
    expect(api.rebases).toEqual([mr.number]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(out.headSha).toBe(api.branches.get("b"));
    expect(out.headSha).not.toBe(head);
    // A rebase makes no merge commit, so no approval carries onto it.
    expect(out.parents).toBeNull();
    await expect(seam.holdsCommit(repo, out.headSha, main)).resolves.toBe(true);
    expect(Object.fromEntries(api.tree(out.headSha))).toEqual({
      a: "1",
      z: "1",
    });
  });

  it("refuses a branch update when the branch moved, before asking GitLab to rebase", async () => {
    const { api, seam, repo, mr } = await onBranch();
    await expect(
      seam.updateBranch(repo, {
        number: mr.number,
        branch: "b",
        expectedHead: "c0",
        base: "main",
      }),
    ).rejects.toMatchObject({ reason: "head_moved" });
    expect(api.rebases).toEqual([]);
  });

  it("refuses a rebase that conflicts as update_conflict with GitLab's reason", async () => {
    const { api, seam, repo, head, mr } = await onBranch();
    api.commit("main", "a", "2");
    await expect(
      seam.updateBranch(repo, {
        number: mr.number,
        branch: "b",
        expectedHead: head,
        base: "main",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "update_conflict",
      message: expect.stringContaining("conflict in a"),
    });
    expect(api.branches.get("b")).toBe(head);
  });

  it("gives up on a rebase still running after thirty polls", async () => {
    const { api, seam, repo, sleep, head, mr } = await onBranch();
    api.rebaseStuck = true;
    await expect(
      seam.updateBranch(repo, {
        number: mr.number,
        branch: "b",
        expectedHead: head,
        base: "main",
      }),
    ).rejects.toMatchObject({
      reason: "update_conflict",
      message: expect.stringContaining("still rebasing"),
    });
    expect(sleep).toHaveBeenCalledTimes(30);
  });

  it("resets a branch by deleting it and creating it again at the SHA", async () => {
    const { api, seam, repo, head } = await onBranch();
    const stamp = api.commit("b", "a", "stamped");
    await expect(
      seam.resetBranch(repo, "b", { from: stamp, to: head }),
    ).resolves.toBe(true);
    expect(api.branches.get("b")).toBe(head);
  });

  it("leaves a branch that moved off the stamp", async () => {
    const { api, seam, repo, head } = await onBranch();
    const stamp = api.commit("b", "a", "stamped");
    const pushed = api.commit("b", "a", "pushed");
    await expect(
      seam.resetBranch(repo, "b", { from: stamp, to: head }),
    ).resolves.toBe(false);
    expect(api.branches.get("b")).toBe(pushed);
    await expect(
      seam.resetBranch(repo, "gone", { from: stamp, to: head }),
    ).resolves.toBe(false);
    expect(api.branches.has("gone")).toBe(false);
  });

  it("lists approvals with each reviewer's linked Oxagen user at the current head", async () => {
    const { api, seam, repo, mr, head, linkAccount } = await onBranch();
    api.approvedBy = [
      { id: 501, username: "reviewer" },
      { id: 777, username: "stranger" },
    ];
    await expect(seam.listApprovals(repo, mr.number)).resolves.toEqual([
      { userId: REVIEWER, login: "reviewer", commitSha: head },
      { userId: null, login: "stranger", commitSha: head },
    ]);
    expect(linkAccount).toHaveBeenCalledWith("gitlab", "777");
    // The setting is read before the approvals, and the head after them.
    expect(api.restCalls.slice(-2)).toEqual([
      "GET /approvals",
      "GET /merge_requests/1/approvals",
    ]);
  });

  it("drops an approval when a push follows it, so none stands on the new head", async () => {
    const { api, seam, repo, mr, head } = await onBranch();
    await expect(seam.listApprovals(repo, mr.number)).resolves.toEqual([
      { userId: REVIEWER, login: "reviewer", commitSha: head },
    ]);
    api.commit("b", "a", "pushed after the approval");
    await expect(seam.listApprovals(repo, mr.number)).resolves.toEqual([]);
  });

  it("refuses approvals_not_head_bound when the project keeps approvals on push", async () => {
    const { api, seam, repo, mr } = await onBranch();
    api.resetApprovalsOnPush = false;
    // GitLab keeps the approval across the push, so it no longer shows which
    // head was reviewed.
    api.commit("b", "a", "pushed after the approval");
    expect(api.approvedBy).toHaveLength(1);
    await expect(seam.listApprovals(repo, mr.number)).rejects.toMatchObject({
      code: "conflict",
      reason: "approvals_not_head_bound",
      message: expect.stringContaining('Turn on "Reset approvals on push"'),
    });
    expect(api.restCalls).not.toContain("GET /merge_requests/1/approvals");
  });

  it("refuses approvals_not_head_bound when GitLab will not read the setting", async () => {
    const { api, seam, repo, mr } = await onBranch();
    api.resetApprovalsOnPush = null;
    await expect(seam.listApprovals(repo, mr.number)).rejects.toMatchObject({
      code: "conflict",
      reason: "approvals_not_head_bound",
      message: expect.stringContaining("The setting needs GitLab Premium."),
    });
  });

  it("names a revoked token, not the setting, when GitLab rejects the approvals read", async () => {
    const { api, seam, repo, mr } = await onBranch();
    api.revoked = true;
    await expect(seam.listApprovals(repo, mr.number)).rejects.toMatchObject({
      reason: "gitlab_credential_rejected",
    });
  });

  it("records a publish as a successful deployment with no page of its own", async () => {
    const { api, seam, repo } = await onBranch();
    await expect(
      seam.recordDeployment(repo, {
        sha: "gl9",
        ref: "main",
        environment: "steering",
        description: "v3",
      }),
    ).resolves.toEqual({ url: null });
    expect(api.deployments).toEqual([
      {
        environment: "steering",
        sha: "gl9",
        ref: "main",
        tag: false,
        status: "success",
      },
    ]);
  });

  it("wraps a refused deployment as gitlab_refused, and a revoked token as rejected", async () => {
    const { api, seam, repo } = await onBranch();
    api.deploymentsRefused = true;
    const args = {
      sha: "gl9",
      ref: "main",
      environment: "steering",
      description: "v3",
    };
    await expect(seam.recordDeployment(repo, args)).rejects.toMatchObject({
      reason: "gitlab_refused",
      message: expect.stringContaining("403"),
    });
    api.revoked = true;
    await expect(seam.recordDeployment(repo, args)).rejects.toMatchObject({
      reason: "gitlab_credential_rejected",
    });
  });

  it("refuses a REST call on a handle it did not resolve", async () => {
    const { seam, repo } = await onBranch();
    const forged = { ...repo } as SteeringRepository;
    await expect(seam.holdsCommit(forged, "a", "b")).rejects.toThrow(
      "no GitLab client",
    );
  });
});

describe("the plain GitLab REST caller", () => {
  function answering(status: number, body: string, statusText = "") {
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(status === 204 ? null : body, { status, statusText }),
    );
    return {
      fetch,
      rest: gitlabRest({
        token: TOKEN,
        baseUrl: "https://gitlab.example.com/",
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    };
  }

  it("sends the token in its header and JSON bodies to the v4 API", async () => {
    const { fetch, rest } = answering(201, '{"id":7}');
    await expect(
      rest.request("POST", "/projects/1/deployments", { a: 1 }),
    ).resolves.toEqual({ status: 201, data: { id: 7 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://gitlab.example.com/api/v4/projects/1/deployments");
    expect(init).toMatchObject({
      method: "POST",
      body: '{"a":1}',
      headers: {
        "PRIVATE-TOKEN": TOKEN,
        "Content-Type": "application/json",
      },
    });
  });

  it("answers no data for a 204 and sends no body when given none", async () => {
    const { fetch, rest } = answering(204, "");
    await expect(rest.request("PUT", "/x")).resolves.toEqual({
      status: 204,
      data: undefined,
    });
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("body");
  });

  it("throws GitLab's message with the token scrubbed and the text capped", async () => {
    const { rest } = answering(
      400,
      JSON.stringify({ message: `bad ${TOKEN} ${"x".repeat(600)}` }),
    );
    const err = await rest.request("GET", "/x").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    const message = (err as Error).message;
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("[redacted]");
    expect(message).toContain("...");
    expect(message.length).toBeLessThan(560);
  });

  it("reads an error field, a structured message, or the status text", async () => {
    const fromError = answering(404, '{"error":"404 Project Not Found"}');
    await expect(fromError.rest.request("GET", "/x")).rejects.toThrow(
      "404 Project Not Found",
    );
    const structured = answering(400, '{"message":{"sha":["is stale"]}}');
    await expect(structured.rest.request("GET", "/x")).rejects.toThrow(
      "is stale",
    );
    const plain = answering(502, "<html>", "Bad Gateway");
    await expect(plain.rest.request("GET", "/x")).rejects.toThrow(
      "Bad Gateway",
    );
    const bare = answering(500, "");
    await expect(bare.rest.request("GET", "/x")).rejects.toThrow(
      "request failed",
    );
  });
});

describe("the host dispatcher", () => {
  it("sends a workspace with no GitLab main head to GitHub", async () => {
    const github = {
      resolveRepository: vi.fn(async () => ({ provider: "github" })),
    };
    const gitlab = { resolveRepository: vi.fn() };
    const host = createSteeringHost({
      mainProvider: async () => null,
      github: github as unknown as SteeringHost,
      gitlab: gitlab as unknown as SteeringHost,
    });
    await host.resolveRepository(SCOPE);
    expect(github.resolveRepository).toHaveBeenCalled();
    expect(gitlab.resolveRepository).not.toHaveBeenCalled();
  });

  it("routes every call on a handle to the host that resolved it", async () => {
    const readFile = vi.fn(async () => "from github");
    const host = createSteeringHost({
      mainProvider: async () => "gitlab",
      github: { readFile } as unknown as SteeringHost,
      gitlab: NO_GITHUB,
    });
    const githubHandle = { provider: "github" } as SteeringRepository;
    await expect(host.readFile(githubHandle, "p", "main")).resolves.toBe(
      "from github",
    );
    expect(() =>
      host.readFile({ provider: "gitlab" } as SteeringRepository, "p", "main"),
    ).toThrow("GitHub was asked to readFile");
  });

  it("routes the merge-queue calls to the handle's host", async () => {
    const calls: string[] = [];
    const gitlab = new Proxy({} as SteeringHost, {
      get: (_t, name) => () => {
        calls.push(String(name));
        return Promise.resolve(null);
      },
    });
    const host = createSteeringHost({
      mainProvider: async () => "gitlab",
      github: NO_GITHUB,
      gitlab,
    });
    const repo = { provider: "gitlab" } as SteeringRepository;
    await host.changedFiles(repo, "a", "b");
    await host.commitFiles(repo, {
      branch: "b",
      parent: "a",
      message: "m",
      files: [],
    });
    await host.holdsCommit(repo, "b", "a");
    await host.updateBranch(repo, {
      number: 1,
      branch: "b",
      expectedHead: "a",
      base: "c",
    });
    await host.resetBranch(repo, "b", { from: "b", to: "a" });
    await host.listApprovals(repo, 1);
    await host.recordDeployment(repo, {
      sha: "a",
      ref: "main",
      environment: "steering",
      description: "d",
    });
    expect(calls).toEqual([
      "changedFiles",
      "commitFiles",
      "holdsCommit",
      "updateBranch",
      "resetBranch",
      "listApprovals",
      "recordDeployment",
    ]);
  });
});
