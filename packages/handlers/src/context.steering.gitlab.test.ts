// The GitLab steering seam (#3762), against an in-memory gitlab.com project.
//
// The first block runs the real handlers end to end: a proposal becomes a
// merge request on the GitLab project, its six checks become commit statuses,
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
const BRANCH = `context/${LINEAGE}`;

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
  const seam = createSteeringGitLab({
    readConnection: async () => connection,
    resolveToken,
    client: (token) => api.client(token),
    sleep,
  });
  return { seam, resolveToken, sleep };
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
  it("opens a merge request, reports six commit statuses, then squash-merges the checked head and publishes", async () => {
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
    expect(api.statuses).toHaveLength(6);
    expect(
      api.statuses.every((s) => s.sha === head && s.state === "success"),
    ).toBe(true);
    expect(api.statuses.map((s) => s.name)).toContain("Oxagen · Schema");
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
        message: `steering: publish ${LINEAGE} (#1)`,
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
});
