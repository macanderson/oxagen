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
  const withTenantDb = vi.fn();

  const mockClient = {
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
    getAuthenticatedUser,
  };

  return {
    createRepoInOrg,
    putFile,
    forkRepo,
    createBranch,
    openPullRequest,
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
});

// ── 4: repo.file.put handler ──────────────────────────────────────────────────

describe("repo.file.put handler", () => {
  it(
    "calls putFile with correct args",
    withToken(async () => {
      mocks.putFile.mockResolvedValueOnce({
        commitSha: "abc123",
        htmlUrl: "https://github.com/myorg/myrepo/blob/main/src/index.ts",
      });

      const result = await repoFilePutHandler(
        {
          owner: "myorg",
          repo: "myrepo",
          path: "src/index.ts",
          content: "export const x = 1;",
          message: "Add index.ts",
          branch: "main",
        },
        ctx,
      );

      expect(mocks.putFile).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        path: "src/index.ts",
        content: "export const x = 1;",
        message: "Add index.ts",
        branch: "main",
      });
      expect(result).toEqual({
        commitSha: "abc123",
        htmlUrl: "https://github.com/myorg/myrepo/blob/main/src/index.ts",
      });
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
});
