/**
 * Tests for the read-only GitHub capability handlers:
 *   repo.ci.status, repo.pr.get, repo.pr.diff, repo.branch.list.
 *
 * Strategy mirrors github-caps.test.ts: mock @oxagen/github so
 * createGitHubClient returns spy methods, mock @oxagen/database withTenantDb to
 * return no workspace connection so resolveGitHubToken falls through to the
 * GITHUB_PERSONAL_ACCESS_TOKEN env-var path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  GitHubCiChecks,
  GitHubPrComments,
  GitHubPrFile,
  GitHubPullRequest,
} from "@oxagen/github";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const getPullRequest = vi.fn();
  const listPullRequestComments = vi.fn();
  const listCiChecks = vi.fn();
  const listPullRequestFiles = vi.fn();
  const listBranches = vi.fn();
  const getRepoInfo = vi.fn();
  const withTenantDb = vi.fn();

  const mockClient = {
    getPullRequest,
    listPullRequestComments,
    listCiChecks,
    listPullRequestFiles,
    listBranches,
    getRepoInfo,
  };

  return {
    getPullRequest,
    listPullRequestComments,
    listCiChecks,
    listPullRequestFiles,
    listBranches,
    getRepoInfo,
    mockClient,
    withTenantDb,
  };
});

vi.mock("@oxagen/database", () => ({
  schema: {
    sourceConnections: {
      orgId: "sc.orgId",
      workspaceId: "sc.workspaceId",
      connectorId: "sc.connectorId",
      status: "sc.status",
      deletedAt: "sc.deletedAt",
      oauthAccountId: "sc.oauthAccountId",
      deliveryConfig: "sc.deliveryConfig",
    },
    oauthAccounts: { id: "oa.id", accessTokenEnc: "oa.accessTokenEnc" },
  },
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    and: (...args: unknown[]) => ({ __and: args }),
    eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
    isNull: (col: unknown) => ({ __isNull: col }),
  };
});

vi.mock("@oxagen/github", () => ({
  createGitHubClient: () => mocks.mockClient,
  getInstallationToken: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import type { CapabilityContext } from "@oxagen/oxagen";
import { repoCiStatusHandler } from "../repo.ci.status";
import { repoPrGetHandler } from "../repo.pr.get";
import { repoPrDiffHandler } from "../repo.pr.diff";
import { repoBranchListHandler } from "../repo.branch.list";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

const TOKEN = "ghp_test_token";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockResolvedValue([]);
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function checks(partial: Partial<GitHubCiChecks>): GitHubCiChecks {
  return { sha: "sha1", checkRuns: [], statuses: [], ...partial };
}

function run(
  over: Partial<GitHubCiChecks["checkRuns"][number]>,
): GitHubCiChecks["checkRuns"][number] {
  return {
    name: "check",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    appName: "GitHub Actions",
    ...over,
  };
}

// ── repo.ci.status: overall derivation edge cases ─────────────────────────────

describe("repo.ci.status handler", () => {
  it("returns unknown for an empty check set", async () => {
    mocks.listCiChecks.mockResolvedValueOnce(checks({ sha: null }));
    const out = await repoCiStatusHandler(
      { owner: "a", repo: "b", ref: "main" },
      ctx,
    );
    expect(out.overall).toBe("unknown");
    expect(out.sha).toBeNull();
    expect(out.ref).toBe("main");
    expect(out.counts.total).toBe(0);
  });

  it("returns passing when all checks succeed", async () => {
    mocks.listCiChecks.mockResolvedValueOnce(
      checks({ checkRuns: [run({}), run({ name: "test" })] }),
    );
    const out = await repoCiStatusHandler(
      { owner: "a", repo: "b", ref: "main" },
      ctx,
    );
    expect(out.overall).toBe("passing");
    expect(out.counts).toMatchObject({ total: 2, passed: 2, failed: 0 });
  });

  it("returns failing when any check fails, even with pending present", async () => {
    mocks.listCiChecks.mockResolvedValueOnce(
      checks({
        checkRuns: [
          run({ name: "ok" }),
          run({ name: "bad", conclusion: "failure" }),
          run({ name: "wip", status: "in_progress", conclusion: null }),
        ],
      }),
    );
    const out = await repoCiStatusHandler(
      { owner: "a", repo: "b", ref: "main" },
      ctx,
    );
    expect(out.overall).toBe("failing");
    expect(out.counts).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
    });
  });

  it("returns pending when a check is queued and none failed", async () => {
    mocks.listCiChecks.mockResolvedValueOnce(
      checks({
        checkRuns: [
          run({ name: "ok" }),
          run({ name: "queued", status: "queued", conclusion: null }),
        ],
      }),
    );
    const out = await repoCiStatusHandler(
      { owner: "a", repo: "b", ref: "main" },
      ctx,
    );
    expect(out.overall).toBe("pending");
  });

  it("returns neutral when completed checks are non-success and non-failing", async () => {
    mocks.listCiChecks.mockResolvedValueOnce(
      checks({
        checkRuns: [
          run({ name: "ok" }),
          run({ name: "skip", conclusion: "skipped" }),
        ],
      }),
    );
    const out = await repoCiStatusHandler(
      { owner: "a", repo: "b", ref: "main" },
      ctx,
    );
    expect(out.overall).toBe("neutral");
    expect(out.counts).toMatchObject({ passed: 1, skipped: 1 });
  });

  it("computes durationMs and merges legacy statuses into runs", async () => {
    mocks.listCiChecks.mockResolvedValueOnce(
      checks({
        checkRuns: [
          run({
            name: "build",
            startedAt: "2026-07-06T10:00:00Z",
            completedAt: "2026-07-06T10:02:00Z",
          }),
        ],
        statuses: [
          {
            context: "legacy",
            state: "success",
            targetUrl: "u",
            createdAt: "2026-07-06T10:00:00Z",
            updatedAt: "2026-07-06T10:01:00Z",
          },
        ],
      }),
    );
    const out = await repoCiStatusHandler(
      { owner: "a", repo: "b", ref: "main" },
      ctx,
    );
    expect(out.runs).toHaveLength(2);
    expect(out.runs[0]?.durationMs).toBe(120000);
    // legacy status normalised into a run
    const legacy = out.runs.find((r) => r.name === "legacy");
    expect(legacy?.conclusion).toBe("success");
    expect(legacy?.app).toBeNull();
    expect(out.overall).toBe("passing");
  });
});

// ── repo.pr.get: state mapping, comment cap + true counts ─────────────────────

function pr(over: Partial<GitHubPullRequest>): GitHubPullRequest {
  return {
    number: 42,
    title: "t",
    htmlUrl: "url",
    state: "open",
    draft: false,
    merged: false,
    authorLogin: "octocat",
    authorAvatarUrl: "av",
    createdAt: "2026-07-06T10:00:00Z",
    updatedAt: "2026-07-06T10:30:00Z",
    body: "b",
    baseRef: "main",
    headRef: "feature",
    headSha: "sha1",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    commits: 1,
    commentCount: 99,
    reviewCommentCount: 7,
    ...over,
  };
}

const noComments: GitHubPrComments = { issue: [], review: [] };

describe("repo.pr.get handler", () => {
  it("maps merged=true to state 'merged'", async () => {
    mocks.getPullRequest.mockResolvedValueOnce(
      pr({ merged: true, state: "closed" }),
    );
    mocks.listPullRequestComments.mockResolvedValueOnce(noComments);
    mocks.listCiChecks.mockResolvedValueOnce(checks({}));

    const out = await repoPrGetHandler(
      { owner: "a", repo: "b", number: 42 },
      ctx,
    );
    expect(out.state).toBe("merged");
  });

  it("maps closed-not-merged to 'closed' and open to 'open'", async () => {
    mocks.getPullRequest.mockResolvedValueOnce(
      pr({ merged: false, state: "closed" }),
    );
    mocks.listPullRequestComments.mockResolvedValueOnce(noComments);
    mocks.listCiChecks.mockResolvedValueOnce(checks({}));
    const closed = await repoPrGetHandler(
      { owner: "a", repo: "b", number: 1 },
      ctx,
    );
    expect(closed.state).toBe("closed");

    mocks.getPullRequest.mockResolvedValueOnce(
      pr({ merged: false, state: "open" }),
    );
    mocks.listPullRequestComments.mockResolvedValueOnce(noComments);
    mocks.listCiChecks.mockResolvedValueOnce(checks({}));
    const open = await repoPrGetHandler(
      { owner: "a", repo: "b", number: 2 },
      ctx,
    );
    expect(open.state).toBe("open");
  });

  it("caps comments at 50 newest-first but keeps true counts from the PR", async () => {
    // 40 issue + 40 review = 80 comments; each createdAt encodes its ordinal.
    const issue = Array.from({ length: 40 }, (_, i) => ({
      id: `i${i}`,
      authorLogin: "a",
      authorAvatarUrl: null,
      body: `issue-${i}`,
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
      htmlUrl: null,
      path: null,
    }));
    const review = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      authorLogin: "b",
      authorAvatarUrl: null,
      body: `review-${i}`,
      createdAt: new Date(2026, 0, 2, 0, i).toISOString(),
      htmlUrl: null,
      path: "src/x.ts",
    }));
    mocks.getPullRequest.mockResolvedValueOnce(pr({}));
    mocks.listPullRequestComments.mockResolvedValueOnce({ issue, review });
    mocks.listCiChecks.mockResolvedValueOnce(checks({}));

    const out = await repoPrGetHandler(
      { owner: "a", repo: "b", number: 42 },
      ctx,
    );

    expect(out.comments).toHaveLength(50);
    // True totals come from the PR object, not the fetched array length.
    expect(out.commentCount).toBe(99);
    expect(out.reviewCommentCount).toBe(7);
    // Newest first: the last review comment (Jan 2) sorts ahead of issues (Jan 1).
    expect(out.comments[0]?.createdAt).toBe(
      new Date(2026, 0, 2, 0, 39).toISOString(),
    );
    expect(out.comments[0]?.kind).toBe("review");
    expect(out.comments[0]?.path).toBe("src/x.ts");
  });

  it("skips CI fetch when the PR has no head SHA", async () => {
    mocks.getPullRequest.mockResolvedValueOnce(pr({ headSha: null }));
    mocks.listPullRequestComments.mockResolvedValueOnce(noComments);

    const out = await repoPrGetHandler(
      { owner: "a", repo: "b", number: 42 },
      ctx,
    );
    expect(mocks.listCiChecks).not.toHaveBeenCalled();
    expect(out.ci.overall).toBe("unknown");
    expect(out.headSha).toBeNull();
  });
});

// ── repo.pr.diff: summary, totals, binary detection ───────────────────────────

function file(over: Partial<GitHubPrFile>): GitHubPrFile {
  return {
    path: "src/x.ts",
    previousPath: null,
    status: "modified",
    additions: 0,
    deletions: 0,
    changes: 0,
    patch: null,
    ...over,
  };
}

describe("repo.pr.diff handler", () => {
  it("flags a binary file (null patch, nonzero changes) and sums totals", async () => {
    mocks.listPullRequestFiles.mockResolvedValueOnce([
      file({
        path: "src/a.ts",
        status: "added",
        additions: 40,
        deletions: 0,
        changes: 40,
        patch: "@@",
      }),
      file({
        path: "logo.png",
        status: "modified",
        additions: 0,
        deletions: 0,
        changes: 12,
        patch: null,
      }),
      file({
        path: "src/b.ts",
        status: "modified",
        additions: 2,
        deletions: 5,
        changes: 7,
        patch: "@@",
      }),
    ]);

    const out = await repoPrDiffHandler(
      { owner: "a", repo: "b", number: 3 },
      ctx,
    );

    expect(out.additions).toBe(42);
    expect(out.deletions).toBe(5);
    expect(out.changedFiles).toBe(3);
    expect(out.summary).toBe("3 files, +42 -5");
    const binary = out.files.find((f) => f.path === "logo.png");
    expect(binary?.binary).toBe(true);
    const text = out.files.find((f) => f.path === "src/a.ts");
    expect(text?.binary).toBe(false);
  });

  it("does not flag an empty patch-less file with zero changes as binary", async () => {
    mocks.listPullRequestFiles.mockResolvedValueOnce([
      file({
        path: "empty.txt",
        status: "added",
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: null,
      }),
    ]);
    const out = await repoPrDiffHandler(
      { owner: "a", repo: "b", number: 4 },
      ctx,
    );
    expect(out.files[0]?.binary).toBe(false);
    expect(out.summary).toBe("1 file, +0 -0");
  });
});

// ── repo.branch.list handler ──────────────────────────────────────────────

describe("repo.branch.list handler", () => {
  it("calls listBranches and getRepoInfo, marking the default branch", async () => {
    mocks.listBranches.mockResolvedValueOnce([
      { name: "main", sha: "sha-main", protected: true },
      { name: "feature/x", sha: "sha-x", protected: false },
    ]);
    mocks.getRepoInfo.mockResolvedValueOnce({
      fullName: "acme/repo",
      htmlUrl: "https://github.com/acme/repo",
      defaultBranch: "main",
    });

    const out = await repoBranchListHandler(
      { owner: "acme", repo: "repo" },
      ctx,
    );

    expect(mocks.listBranches).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
    });
    expect(mocks.getRepoInfo).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
    });
    expect(out.defaultBranch).toBe("main");
    expect(out.branches).toEqual([
      { name: "main", sha: "sha-main", isDefault: true, protected: true },
      { name: "feature/x", sha: "sha-x", isDefault: false, protected: false },
    ]);
  });

  it("returns an empty branches array for an empty repository", async () => {
    mocks.listBranches.mockResolvedValueOnce([]);
    mocks.getRepoInfo.mockResolvedValueOnce({
      fullName: "acme/empty",
      htmlUrl: "https://github.com/acme/empty",
      defaultBranch: "main",
    });

    const out = await repoBranchListHandler(
      { owner: "acme", repo: "empty" },
      ctx,
    );

    expect(out.branches).toEqual([]);
    expect(out.defaultBranch).toBe("main");
  });

  it("resolves defaultBranch to null when the repo-info lookup fails, without failing the whole call", async () => {
    mocks.listBranches.mockResolvedValueOnce([
      { name: "main", sha: "sha-main", protected: true },
    ]);
    mocks.getRepoInfo.mockRejectedValueOnce(new Error("boom"));

    const out = await repoBranchListHandler(
      { owner: "acme", repo: "repo" },
      ctx,
    );

    expect(out.defaultBranch).toBeNull();
    expect(out.branches).toEqual([
      { name: "main", sha: "sha-main", isDefault: false, protected: true },
    ]);
  });

  it("propagates a token resolution failure", async () => {
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

    await expect(
      repoBranchListHandler({ owner: "acme", repo: "repo" }, ctx),
    ).rejects.toThrow("No GitHub connection for this workspace");

    expect(mocks.listBranches).not.toHaveBeenCalled();
  });
});
