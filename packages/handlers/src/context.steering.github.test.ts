import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import {
  createSteeringGitHub,
  readGitHubConnection,
} from "./context.steering.github";

const SCOPE = { orgId: "org", workspaceId: "ws" };

function fakeClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getRepoInfo: async () => ({
      fullName: "a-intel/platform",
      htmlUrl: "",
      defaultBranch: "main",
    }),
    createBranch: async () => ({ ref: "refs/heads/x", sha: "s" }),
    putFile: async () => ({ commitSha: "c1", htmlUrl: "" }),
    openPullRequest: async () => ({ number: 1, htmlUrl: "u" }),
    getFileContent: async () => null,
    createCheckRun: async () => ({
      id: 1,
      htmlUrl: "https://github.com/x/runs/1",
    }),
    mergePullRequest: async () => ({ sha: "m", merged: true }),
    ...over,
  } as unknown as GitHubClient;
}

function seam(
  client: GitHubClient,
  connection: { owner: string; repo: string } | null = {
    owner: "a-intel",
    repo: "platform",
  },
) {
  const resolveToken = vi.fn(async () => "tok");
  const gh = createSteeringGitHub({
    readConnection: async () => connection,
    resolveToken,
    client: () => client,
  });
  return { gh, resolveToken };
}

describe("the GitHub seam", () => {
  it("resolves the workspace's connected repository with its default branch, using the workspace's token", async () => {
    const { gh, resolveToken } = seam(fakeClient());
    const repo = await gh.resolveRepository(SCOPE);
    expect(repo).toEqual({
      owner: "a-intel",
      repo: "platform",
      fullName: "a-intel/platform",
      defaultBranch: "main",
    });
    expect(resolveToken).toHaveBeenCalledWith(SCOPE);
  });

  it("refuses a workspace with no connected repository before minting a token", async () => {
    const { gh, resolveToken } = seam(fakeClient(), null);
    await expect(gh.resolveRepository(SCOPE)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_repository_missing",
    });
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("reuses an existing branch and wraps any other GitHub refusal as github_refused", async () => {
    const createBranch = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("GitHub API error 422: Reference already exists"),
      )
      .mockRejectedValueOnce(new Error("GitHub API error 404: Not Found"));
    const { gh } = seam(fakeClient({ createBranch }));
    const repo = await gh.resolveRepository(SCOPE);
    await expect(
      gh.ensureBranch(repo, "context/x", "main"),
    ).resolves.toBeUndefined();
    await expect(
      gh.ensureBranch(repo, "context/x", "main"),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "github_refused",
      message: "GitHub API error 404: Not Found",
    });
  });

  it("records a check run's url, answers null when the token cannot write checks, and refuses on anything else", async () => {
    const createCheckRun = vi
      .fn()
      .mockResolvedValueOnce({ id: 1, htmlUrl: "https://github.com/x/runs/1" })
      .mockRejectedValueOnce(
        new Error(
          "GitHub API error 403: Resource not accessible by integration",
        ),
      )
      .mockRejectedValueOnce(new Error("GitHub API error 500: boom"));
    const { gh } = seam(fakeClient({ createCheckRun }));
    const repo = await gh.resolveRepository(SCOPE);
    const args = {
      name: "n",
      headSha: "s",
      conclusion: "success" as const,
      title: "t",
      summary: "s",
      startedAt: "a",
      completedAt: "b",
    };
    expect(await gh.reportCheckRun(repo, args)).toBe(
      "https://github.com/x/runs/1",
    );
    expect(await gh.reportCheckRun(repo, args)).toBeNull();
    await expect(gh.reportCheckRun(repo, args)).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("merges with squash pinned to the head sha and surfaces GitHub's refusal", async () => {
    const mergePullRequest = vi
      .fn()
      .mockResolvedValueOnce({ sha: "m1", merged: true })
      .mockRejectedValueOnce(
        new Error(
          "GitHub API error 405: At least 1 approving review is required",
        ),
      );
    const { gh } = seam(fakeClient({ mergePullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    const args = { number: 519, commitTitle: "t", sha: "head1" };
    expect(await gh.mergePullRequest(repo, args)).toEqual({ sha: "m1" });
    expect(mergePullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      number: 519,
      mergeMethod: "squash",
      commitTitle: "t",
      sha: "head1",
    });
    await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
      reason: "github_refused",
      message: expect.stringContaining("approving review"),
    });
  });

  it("reads a PR's base, head and merge commit, and wraps a GitHub refusal", async () => {
    const getPullRequest = vi
      .fn()
      .mockResolvedValueOnce({
        baseRef: "main",
        headSha: "head2",
        merged: true,
        mergeCommitSha: "m2",
      })
      .mockRejectedValueOnce(new Error("GitHub API error 404: Not Found"));
    const { gh } = seam(fakeClient({ getPullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    expect(await gh.getPullRequest(repo, 519)).toEqual({
      baseRef: "main",
      headSha: "head2",
      merged: true,
      mergeCommitSha: "m2",
    });
    expect(getPullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      number: 519,
    });
    await expect(gh.getPullRequest(repo, 519)).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("names both paths of a rename among the changed paths, finds the open PR on a branch, and wraps a GitHub refusal", async () => {
    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce([
        { path: ".oxagen/rules/ctx.a.toml", previousPath: null },
        { path: "docs/x.md", previousPath: ".oxagen/rules/governance.toml" },
      ])
      .mockRejectedValueOnce(new Error("GitHub API error 404: Not Found"));
    const findOpenPullRequest = vi
      .fn()
      .mockResolvedValueOnce({ number: 519, htmlUrl: "u", body: "b" });
    const { gh } = seam(fakeClient({ compareCommits, findOpenPullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    expect(await gh.changedPaths(repo, "main", "head1")).toEqual([
      ".oxagen/rules/ctx.a.toml",
      ".oxagen/rules/governance.toml",
      "docs/x.md",
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      base: "main",
      head: "head1",
    });
    await expect(gh.changedPaths(repo, "main", "head1")).rejects.toMatchObject({
      reason: "github_refused",
    });
    expect(
      await gh.findOpenPullRequest(repo, { head: "context/x", base: "main" }),
    ).toEqual({ number: 519, htmlUrl: "u", body: "b" });
    expect(findOpenPullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      head: "context/x",
      base: "main",
    });
  });

  it("closes a PR, deletes a branch, treats a branch already gone as deleted, and wraps any other refusal", async () => {
    const closePullRequest = vi.fn().mockResolvedValueOnce(undefined);
    const deleteBranch = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new Error("GitHub API error 422: Reference does not exist"),
      )
      .mockRejectedValueOnce(new Error("GitHub API error 403: Forbidden"));
    const { gh } = seam(fakeClient({ closePullRequest, deleteBranch }));
    const repo = await gh.resolveRepository(SCOPE);
    await expect(gh.closePullRequest(repo, 519)).resolves.toBeUndefined();
    expect(closePullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      number: 519,
    });
    await expect(gh.deleteBranch(repo, "context/x")).resolves.toBeUndefined();
    await expect(gh.deleteBranch(repo, "context/x")).resolves.toBeUndefined();
    await expect(gh.deleteBranch(repo, "context/x")).rejects.toMatchObject({
      reason: "github_refused",
      message: "GitHub API error 403: Forbidden",
    });
    expect(deleteBranch).toHaveBeenLastCalledWith({
      owner: "a-intel",
      repo: "platform",
      branch: "context/x",
    });
  });

  it("runs each workspace's calls under its own token when two workspaces resolve the same repository", async () => {
    const putA = vi.fn(async () => ({ commitSha: "ca", htmlUrl: "" }));
    const putB = vi.fn(async () => ({ commitSha: "cb", htmlUrl: "" }));
    const byToken: Record<string, GitHubClient> = {
      "tok-a": fakeClient({ putFile: putA }),
      "tok-b": fakeClient({ putFile: putB }),
    };
    const gh = createSteeringGitHub({
      readConnection: async () => ({ owner: "a-intel", repo: "platform" }),
      resolveToken: async (scope) => `tok-${scope.workspaceId}`,
      client: (token) => byToken[token]!,
    });
    const repoA = await gh.resolveRepository({
      orgId: "org",
      workspaceId: "a",
    });
    const repoB = await gh.resolveRepository({
      orgId: "org",
      workspaceId: "b",
    });
    expect(repoA).toEqual(repoB);
    const args = { path: "p", content: "c", message: "m", branch: "x" };
    expect(await gh.putFile(repoA, args)).toEqual({ commitSha: "ca" });
    expect(await gh.putFile(repoB, args)).toEqual({ commitSha: "cb" });
    expect(putA).toHaveBeenCalledTimes(1);
    expect(putB).toHaveBeenCalledTimes(1);
  });

  it("refuses to act on a repository it did not resolve", async () => {
    const { gh } = seam(fakeClient());
    await expect(
      gh.readFile(
        { owner: "o", repo: "r", fullName: "o/r", defaultBranch: "main" },
        "p",
        "main",
      ),
    ).rejects.toThrow("no client for o/r");
  });
});

/**
 * Which repository the seam resolves as the workspace's main repo.
 *
 * `bind_main_repository` writes a binding head and a binding version; the
 * settings-path connection it binds through carries only the installation id
 * the install callback attached, never an owner/repo. A read that looked only
 * at `delivery_config` answered null right after a successful bind, and every
 * Context PR behaved as though no repository were connected.
 */
describe("the workspace's main repository", () => {
  const SELECT_SCOPE = { orgId: "org", workspaceId: "ws" };

  /**
   * The binding read joins (heads → bindings → connections); the legacy read
   * does not join at all, so the chain each takes is what tells them apart.
   */
  function db(opts: { bound?: unknown[]; connections?: unknown[] }): void {
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                innerJoin: () => ({
                  where: () => ({ limit: async () => opts.bound ?? [] }),
                }),
              }),
              where: () => ({ limit: async () => opts.connections ?? [] }),
            }),
          }),
        }),
    );
  }

  it("resolves the repository the bind recorded, on a connection that names none", async () => {
    db({
      bound: [{ owner: "Acme", repo: "Widgets" }],
      connections: [{ deliveryConfig: { installationId: "555" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
      owner: "Acme",
      repo: "Widgets",
    });
  });

  it("prefers the binding over a legacy connection's ingestion sync target", async () => {
    db({
      bound: [{ owner: "Acme", repo: "Widgets" }],
      connections: [{ deliveryConfig: { owner: "a-intel", repo: "platform" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
      owner: "Acme",
      repo: "Widgets",
    });
  });

  it("falls back to the legacy sources wizard's connection when no binding exists", async () => {
    db({
      bound: [],
      connections: [{ deliveryConfig: { owner: "a-intel", repo: "platform" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
      owner: "a-intel",
      repo: "platform",
    });
  });

  it("answers null when neither a binding nor a configured connection names a repository", async () => {
    db({
      bound: [],
      connections: [{ deliveryConfig: { installationId: "5" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toBeNull();
    db({ bound: [], connections: [] });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toBeNull();
  });
});
