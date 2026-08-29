/**
 * Tests for GitHub write capability handlers and the github-token helper.
 *
 * Strategy:
 *  - Mock @oxagen/github so createGitHubClient returns spy methods.
 *  - Mock @oxagen/database withTenantDb to return no workspace connection rows
 *    so resolveGitHubToken falls through to the GITHUB_PERSONAL_ACCESS_TOKEN
 *    env-var fallback (the path exercised by tests 1-2 and used by handlers 3-7).
 *  - Tests for the full ADR-020 resolution chain live in github-token.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const createRepoInOrg = vi.fn();
  const putFile = vi.fn();
  const forkRepo = vi.fn();
  const createBranch = vi.fn();
  const openPullRequest = vi.fn();
  const getAuthenticatedUser = vi.fn();
  const getFileContent = vi.fn();
  const getRepoInfo = vi.fn();
  const withTenantDb = vi.fn();

  const mockClient = {
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
    getAuthenticatedUser,
    getFileContent,
    getRepoInfo,
  };

  return {
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
    getFileContent,
    getRepoInfo,
    mockClient,
    withTenantDb,
  };
});

// withTenantDb always returns no workspace connection so resolveGitHubToken
// falls through to the env-var path (ADR-020 path 3).
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
    oauthAccounts: {
      id: "oa.id",
      accessTokenEnc: "oa.accessTokenEnc",
    },
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
import { resolveGitHubToken } from "../lib/github-token";
import { repoCreateHandler } from "../repo.create";
import { repoFilePutHandler } from "../repo.file.put";
import { repoForkHandler } from "../repo.fork";
import { repoBranchCreateHandler } from "../repo.branch.create";
import { repoPrOpenHandler } from "../repo.pr.open";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

const TOKEN = "ghp_test_token_abcdef";

// ── 1-2: resolveGitHubToken ───────────────────────────────────────────────────

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    // No workspace connection — fall through to env-var path.
    mocks.withTenantDb.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  it("throws when GITHUB_PERSONAL_ACCESS_TOKEN is not set", async () => {
    await expect(resolveGitHubToken(ctx)).rejects.toThrow(
      "No GitHub connection for this workspace",
    );
  });

  it("returns env token when GITHUB_PERSONAL_ACCESS_TOKEN is set", async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = TOKEN;
    const token = await resolveGitHubToken(ctx);
    expect(token).toBe(TOKEN);
  });
});

// ── Handler helpers ───────────────────────────────────────────────────────────

function withToken(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    // No workspace connection — resolveGitHubToken falls through to env-var.
    mocks.withTenantDb.mockResolvedValue([]);
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = TOKEN;
    try {
      await fn();
    } finally {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    }
  };
}

/** Repo lookup consumed by the default-branch write guard. */
function stubRepoInfo(defaultBranch = "main") {
  mocks.getRepoInfo.mockResolvedValueOnce({
    fullName: "myorg/myrepo",
    htmlUrl: "https://github.com/myorg/myrepo",
    defaultBranch,
  });
}

// ── 3: repo.create handler ────────────────────────────────────────────────────

describe("repo.create handler", () => {
  it(
    "calls createRepoInOrg with correct args and returns mapped output",
    withToken(async () => {
      mocks.createRepoInOrg.mockResolvedValueOnce({
        fullName: "myorg/myrepo",
        htmlUrl: "https://github.com/myorg/myrepo",
        defaultBranch: "main",
      });

      const result = await repoCreateHandler(
        {
          org: "myorg",
          name: "myrepo",
          description: "A test repo",
          private: true,
          autoInit: false,
        },
        ctx,
      );

      expect(mocks.createRepoInOrg).toHaveBeenCalledWith({
        org: "myorg",
        name: "myrepo",
        description: "A test repo",
        private: true,
        autoInit: false,
      });
      expect(result).toEqual({
        fullName: "myorg/myrepo",
        htmlUrl: "https://github.com/myorg/myrepo",
        defaultBranch: "main",
      });
    }),
  );

  it(
    "passes undefined optional fields through to createRepoInOrg",
    withToken(async () => {
      mocks.createRepoInOrg.mockResolvedValueOnce({
        fullName: "myorg/bare",
        htmlUrl: "https://github.com/myorg/bare",
        defaultBranch: "main",
      });

      await repoCreateHandler({ org: "myorg", name: "bare" }, ctx);

      expect(mocks.createRepoInOrg).toHaveBeenCalledWith({
        org: "myorg",
        name: "bare",
        description: undefined,
        private: undefined,
        autoInit: undefined,
      });
    }),
  );

  it(
    "creates in the personal account (org undefined) when org is omitted",
    withToken(async () => {
      mocks.createRepoInOrg.mockResolvedValueOnce({
        fullName: "macanderson/hello-world",
        htmlUrl: "https://github.com/macanderson/hello-world",
        defaultBranch: "main",
      });

      const result = await repoCreateHandler(
        { name: "hello-world", autoInit: true },
        ctx,
      );

      expect(mocks.createRepoInOrg).toHaveBeenCalledWith({
        org: undefined,
        name: "hello-world",
        description: undefined,
        private: undefined,
        autoInit: true,
      });
      expect(result).toEqual({
        fullName: "macanderson/hello-world",
        htmlUrl: "https://github.com/macanderson/hello-world",
        defaultBranch: "main",
      });
    }),
  );
});

// ── 4: repo.file.put handler ──────────────────────────────────────────────────

describe("repo.file.put handler", () => {
  it(
    "calls putFile with correct args and emits a real unified diff for a new file",
    withToken(async () => {
      // No prior content — this is a create, so the diff should be a
      // "whole file added" patch (before = "").
      stubRepoInfo("main");
      mocks.getFileContent.mockResolvedValueOnce(null);
      mocks.putFile.mockResolvedValueOnce({
        commitSha: "abc123",
        htmlUrl: "https://github.com/myorg/myrepo/blob/feat/topic/src/index.ts",
      });

      const result = await repoFilePutHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          path: "src/index.ts",
          content: "export const x = 1;",
          message: "Add index.ts",
          branch: "feat/topic",
        },
        ctx,
      );

      expect(mocks.getFileContent).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        path: "src/index.ts",
        ref: "feat/topic",
      });
      expect(mocks.putFile).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        path: "src/index.ts",
        content: "export const x = 1;",
        message: "Add index.ts",
        branch: "feat/topic",
      });
      expect(result.commitSha).toBe("abc123");
      expect(result.htmlUrl).toBe(
        "https://github.com/myorg/myrepo/blob/feat/topic/src/index.ts",
      );
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs?.[0]).toMatchObject({
        path: "src/index.ts",
        additions: 1,
        deletions: 0,
      });
      expect(result.diffs?.[0]?.patch).toContain("+export const x = 1;");
    }),
  );

  it(
    "diffs against the prior content when updating an existing file",
    withToken(async () => {
      stubRepoInfo("main");
      mocks.getFileContent.mockResolvedValueOnce("export const x = 0;");
      mocks.putFile.mockResolvedValueOnce({
        commitSha: "def456",
        htmlUrl: "https://github.com/myorg/myrepo/blob/feat/topic/src/index.ts",
      });

      const result = await repoFilePutHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          path: "src/index.ts",
          content: "export const x = 1;",
          message: "Update index.ts",
          branch: "feat/topic",
        },
        ctx,
      );

      expect(result.diffs).toHaveLength(1);
      expect(result.diffs?.[0]).toMatchObject({
        path: "src/index.ts",
        additions: 1,
        deletions: 1,
      });
      expect(result.diffs?.[0]?.patch).toContain("-export const x = 0;");
      expect(result.diffs?.[0]?.patch).toContain("+export const x = 1;");
    }),
  );

  it(
    "still returns a commit result when reading the prior content fails",
    withToken(async () => {
      stubRepoInfo("main");
      mocks.getFileContent.mockRejectedValueOnce(new Error("network blip"));
      mocks.putFile.mockResolvedValueOnce({
        commitSha: "ghi789",
        htmlUrl: "https://github.com/myorg/myrepo/blob/feat/topic/src/index.ts",
      });

      const result = await repoFilePutHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          path: "src/index.ts",
          content: "export const x = 1;",
          message: "Add index.ts",
          branch: "feat/topic",
        },
        ctx,
      );

      expect(result.commitSha).toBe("ghi789");
      // Falls back to diffing against "" (treated as a new file) rather than
      // failing the whole commit over a non-critical diff-enrichment error.
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs?.[0]?.additions).toBe(1);
    }),
  );

  it(
    "rejects a commit targeting the default branch (OXA-2117)",
    withToken(async () => {
      mocks.putFile.mockClear();
      stubRepoInfo("main");

      await expect(
        repoFilePutHandler(
          {
            owner: "myorg",
            repo: "myrepo",
            path: "src/index.ts",
            content: "export const x = 1;",
            message: "Direct-to-main commit",
            branch: "main",
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("default branch"),
      });

      expect(mocks.putFile).not.toHaveBeenCalled();
    }),
  );

  it(
    "rejects a commit when branch is omitted — it would silently target the default branch",
    withToken(async () => {
      mocks.putFile.mockClear();
      stubRepoInfo("develop");

      await expect(
        repoFilePutHandler(
          {
            owner: "myorg",
            repo: "myrepo",
            path: "src/index.ts",
            content: "export const x = 1;",
            message: "Branchless commit",
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('"develop"'),
      });

      expect(mocks.putFile).not.toHaveBeenCalled();
    }),
  );
});

// ── 5: repo.fork handler — intoOrg → org mapping ─────────────────────────────

describe("repo.fork handler", () => {
  it(
    "maps intoOrg to org when calling forkRepo",
    withToken(async () => {
      mocks.forkRepo.mockResolvedValueOnce({
        fullName: "targetorg/upstream",
        htmlUrl: "https://github.com/targetorg/upstream",
        defaultBranch: "main",
      });

      const result = await repoForkHandler(
        {
          owner: "upstream-owner",
          repo: "upstream",
          intoOrg: "targetorg",
        },
        ctx,
      );

      expect(mocks.forkRepo).toHaveBeenCalledWith({
        owner: "upstream-owner",
        repo: "upstream",
        org: "targetorg",
      });
      expect(result.fullName).toBe("targetorg/upstream");
    }),
  );

  it(
    "passes org as undefined when intoOrg is omitted",
    withToken(async () => {
      mocks.forkRepo.mockResolvedValueOnce({
        fullName: "me/upstream",
        htmlUrl: "https://github.com/me/upstream",
        defaultBranch: "main",
      });

      await repoForkHandler({ owner: "upstream-owner", repo: "upstream" }, ctx);

      expect(mocks.forkRepo).toHaveBeenCalledWith({
        owner: "upstream-owner",
        repo: "upstream",
        org: undefined,
      });
    }),
  );
});

// ── 6: repo.branch.create handler ────────────────────────────────────────────

describe("repo.branch.create handler", () => {
  it(
    "calls createBranch with correct args",
    withToken(async () => {
      stubRepoInfo("main");
      mocks.createBranch.mockResolvedValueOnce({
        ref: "refs/heads/feature/my-branch",
        sha: "deadbeef",
      });

      const result = await repoBranchCreateHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          branch: "feature/my-branch",
          fromBranch: "main",
        },
        ctx,
      );

      expect(mocks.createBranch).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        branch: "feature/my-branch",
        fromBranch: "main",
      });
      expect(result).toEqual({
        ref: "refs/heads/feature/my-branch",
        sha: "deadbeef",
      });
    }),
  );

  it(
    "rejects creating a branch named after the default branch (OXA-2117)",
    withToken(async () => {
      mocks.createBranch.mockClear();
      stubRepoInfo("main");

      await expect(
        repoBranchCreateHandler(
          { owner: "myorg", repo: "myrepo", branch: "main" },
          ctx,
        ),
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("default branch"),
      });

      expect(mocks.createBranch).not.toHaveBeenCalled();
    }),
  );
});

// ── 7: repo.pr.open handler ───────────────────────────────────────────────────

describe("repo.pr.open handler", () => {
  it(
    "calls openPullRequest with correct args and returns { number, htmlUrl }",
    withToken(async () => {
      mocks.openPullRequest.mockResolvedValueOnce({
        number: 42,
        htmlUrl: "https://github.com/myorg/myrepo/pull/42",
      });

      const result = await repoPrOpenHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          title: "My PR",
          head: "feature/my-branch",
          base: "main",
          body: "Description here",
          draft: false,
        },
        ctx,
      );

      expect(mocks.openPullRequest).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        title: "My PR",
        head: "feature/my-branch",
        base: "main",
        body: "Description here",
        draft: false,
      });
      expect(result).toEqual({
        number: 42,
        htmlUrl: "https://github.com/myorg/myrepo/pull/42",
      });
    }),
  );

  it(
    "passes optional fields as undefined when not supplied",
    withToken(async () => {
      mocks.openPullRequest.mockResolvedValueOnce({
        number: 1,
        htmlUrl: "https://github.com/myorg/myrepo/pull/1",
      });

      await repoPrOpenHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          title: "Bare PR",
          head: "feature/x",
          base: "main",
        },
        ctx,
      );

      expect(mocks.openPullRequest).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        title: "Bare PR",
        head: "feature/x",
        base: "main",
        body: undefined,
        draft: undefined,
      });
    }),
  );

  it(
    "rejects a pull request whose head equals its base (OXA-2117)",
    withToken(async () => {
      mocks.openPullRequest.mockClear();

      await expect(
        repoPrOpenHandler(
          {
            owner: "myorg",
            repo: "myrepo",
            title: "Self PR",
            head: "main",
            base: "main",
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("head and base to differ"),
      });

      expect(mocks.openPullRequest).not.toHaveBeenCalled();
    }),
  );
});
