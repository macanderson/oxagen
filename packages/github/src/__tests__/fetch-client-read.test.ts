import { afterEach, describe, it, expect, vi } from "vitest";
import { createGitHubClient } from "../fetch-client";

// ---------------------------------------------------------------------------
// Helpers (mirrors fetch-client.test.ts)
// ---------------------------------------------------------------------------

type JsonBody =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

function makeResponse(body: JsonBody, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// getPullRequest
// ---------------------------------------------------------------------------

describe("getPullRequest", () => {
  it("maps the PR payload to the typed shape with sane defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        number: 42,
        title: "feat: hello",
        html_url: "https://github.com/acme/repo/pull/42",
        state: "open",
        merged: false,
        user: { login: "octocat", avatar_url: "https://avatar/1" },
        created_at: "2026-07-06T10:00:00Z",
        updated_at: "2026-07-06T10:30:00Z",
        body: "desc",
        base: { ref: "main" },
        head: { ref: "feature/hello", sha: "abc123" },
        additions: 40,
        deletions: 2,
        changed_files: 3,
        commits: 1,
        comments: 5,
        review_comments: 2,
        // draft intentionally omitted → defaults to false
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const pr = await client.getPullRequest({
      owner: "acme",
      repo: "repo",
      number: 42,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/repo/pulls/42");
    expect(init.method).toBe("GET");
    expect(pr).toEqual({
      number: 42,
      title: "feat: hello",
      htmlUrl: "https://github.com/acme/repo/pull/42",
      state: "open",
      draft: false,
      merged: false,
      authorLogin: "octocat",
      authorAvatarUrl: "https://avatar/1",
      createdAt: "2026-07-06T10:00:00Z",
      updatedAt: "2026-07-06T10:30:00Z",
      body: "desc",
      baseRef: "main",
      headRef: "feature/hello",
      headSha: "abc123",
      mergeCommitSha: null,
      mergedAt: null,
      additions: 40,
      deletions: 2,
      changedFiles: 3,
      commits: 1,
      commentCount: 5,
      reviewCommentCount: 2,
    });
  });

  it("handles a null author", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        number: 1,
        title: "t",
        html_url: "u",
        state: "closed",
        merged: true,
        user: null,
        created_at: "2026-07-06T10:00:00Z",
        updated_at: "2026-07-06T10:00:00Z",
        body: null,
        base: { ref: "main" },
        head: { ref: "f", sha: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const pr = await client.getPullRequest({
      owner: "a",
      repo: "b",
      number: 1,
    });
    expect(pr.authorLogin).toBeNull();
    expect(pr.authorAvatarUrl).toBeNull();
    expect(pr.merged).toBe(true);
    expect(pr.headSha).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPullRequestComments
// ---------------------------------------------------------------------------

describe("listPullRequestComments", () => {
  it("normalises issue and review comments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse([
          {
            id: 100,
            user: { login: "alice", avatar_url: "a1" },
            body: "issue body",
            created_at: "2026-07-06T09:00:00Z",
            html_url: "iurl",
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeResponse([
          {
            id: 200,
            user: { login: "bob", avatar_url: "a2" },
            body: "review body",
            created_at: "2026-07-06T09:30:00Z",
            html_url: "rurl",
            path: "src/x.ts",
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.listPullRequestComments({
      owner: "a",
      repo: "b",
      number: 7,
    });

    expect(out.issue).toEqual([
      {
        id: "100",
        authorLogin: "alice",
        authorAvatarUrl: "a1",
        body: "issue body",
        createdAt: "2026-07-06T09:00:00Z",
        htmlUrl: "iurl",
        path: null,
      },
    ]);
    expect(out.review).toEqual([
      {
        id: "200",
        authorLogin: "bob",
        authorAvatarUrl: "a2",
        body: "review body",
        createdAt: "2026-07-06T09:30:00Z",
        htmlUrl: "rurl",
        path: "src/x.ts",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// listCiChecks
// ---------------------------------------------------------------------------

describe("listCiChecks", () => {
  it("merges check-runs and combined status, normalising enums", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          total_count: 1,
          check_runs: [
            {
              name: "build",
              status: "completed",
              conclusion: "success",
              details_url: "durl",
              started_at: "2026-07-06T10:00:00Z",
              completed_at: "2026-07-06T10:02:00Z",
              app: { name: "GitHub Actions" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          sha: "sha123",
          statuses: [
            {
              context: "legacy/ci",
              state: "pending",
              target_url: "turl",
              created_at: "2026-07-06T10:00:00Z",
              updated_at: "2026-07-06T10:01:00Z",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.listCiChecks({
      owner: "a",
      repo: "b",
      ref: "main",
    });

    expect(out.sha).toBe("sha123");
    expect(out.checkRuns[0]).toMatchObject({
      name: "build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "durl",
      appName: "GitHub Actions",
    });
    expect(out.statuses[0]).toMatchObject({
      context: "legacy/ci",
      state: "pending",
      targetUrl: "turl",
    });
  });

  it("coerces unknown conclusion and status values", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          total_count: 1,
          check_runs: [
            {
              name: "weird",
              status: "waiting",
              conclusion: "bogus",
              details_url: null,
              started_at: null,
              completed_at: null,
              app: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          sha: "s",
          statuses: [
            {
              context: "c",
              state: "unknown_state",
              target_url: null,
              created_at: null,
              updated_at: null,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.listCiChecks({
      owner: "a",
      repo: "b",
      ref: "main",
    });
    expect(out.checkRuns[0]?.status).toBe("completed");
    expect(out.checkRuns[0]?.conclusion).toBeNull();
    expect(out.statuses[0]?.state).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// listPullRequestFiles
// ---------------------------------------------------------------------------

describe("listPullRequestFiles", () => {
  it("maps files and defaults an omitted patch to null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse([
        {
          filename: "src/hello.ts",
          status: "added",
          additions: 40,
          deletions: 0,
          changes: 40,
          patch: "@@ -0,0 +1,40 @@",
        },
        {
          filename: "logo.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          changes: 12,
          // patch omitted (binary)
        },
        {
          filename: "b.ts",
          previous_filename: "a.ts",
          status: "renamed",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: "@@",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const files = await client.listPullRequestFiles({
      owner: "a",
      repo: "b",
      number: 3,
    });

    expect(files[0]).toEqual({
      path: "src/hello.ts",
      previousPath: null,
      status: "added",
      additions: 40,
      deletions: 0,
      changes: 40,
      patch: "@@ -0,0 +1,40 @@",
    });
    expect(files[1]?.patch).toBeNull();
    expect(files[2]?.previousPath).toBe("a.ts");
    expect(files[2]?.status).toBe("renamed");
  });
});

// ---------------------------------------------------------------------------
// listPullRequests
// ---------------------------------------------------------------------------

describe("listPullRequests", () => {
  it("queries GET /pulls by head and state and maps number and url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse([
          { number: 42, html_url: "https://github.com/acme/repo/pull/42" },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const pulls = await client.listPullRequests({
      owner: "acme",
      repo: "repo",
      head: "acme:agents/reviewer",
      state: "open",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/acme/repo/pulls?head=acme%3Aagents%2Freviewer&state=open&per_page=100",
    );
    expect(init.method).toBe("GET");
    expect(pulls).toEqual([
      { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42" },
    ]);
  });

  it("returns an empty array when no pull request has that head", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const pulls = await client.listPullRequests({
      owner: "acme",
      repo: "repo",
      head: "acme:agents/reviewer",
      state: "open",
    });

    expect(pulls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listBranches
// ---------------------------------------------------------------------------

describe("listBranches", () => {
  it("maps a single page of branches to the typed shape", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse([
        { name: "main", commit: { sha: "sha-main" }, protected: true },
        { name: "feature/x", commit: { sha: "sha-x" }, protected: false },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const branches = await client.listBranches({ owner: "acme", repo: "repo" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/acme/repo/branches?per_page=100&page=1",
    );
    expect(branches).toEqual([
      { name: "main", sha: "sha-main", protected: true },
      { name: "feature/x", sha: "sha-x", protected: false },
    ]);
  });

  it("returns an empty array for an empty repository", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const branches = await client.listBranches({
      owner: "acme",
      repo: "empty",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(branches).toEqual([]);
  });

  it("paginates across multiple full pages and stops on the first short page", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `branch-${start + i}`,
        commit: { sha: `sha-${start + i}` },
        protected: false,
      }));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(page(0, 100)))
      .mockResolvedValueOnce(makeResponse(page(100, 100)))
      .mockResolvedValueOnce(makeResponse(page(200, 40)));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const branches = await client.listBranches({ owner: "acme", repo: "big" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(branches).toHaveLength(240);
    expect(branches[0]).toEqual({
      name: "branch-0",
      sha: "sha-0",
      protected: false,
    });
    expect(branches[239]).toEqual({
      name: "branch-239",
      sha: "sha-239",
      protected: false,
    });
    const pages = fetchMock.mock.calls.map(([url]) =>
      new URL(url as string).searchParams.get("page"),
    );
    expect(pages).toEqual(["1", "2", "3"]);
  });

  it("caps at 3 pages (300 branches) even if the third page is full", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `branch-${start + i}`,
        commit: { sha: `sha-${start + i}` },
        protected: false,
      }));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(page(0, 100)))
      .mockResolvedValueOnce(makeResponse(page(100, 100)))
      .mockResolvedValueOnce(makeResponse(page(200, 100)));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const branches = await client.listBranches({ owner: "acme", repo: "huge" });

    // Exactly 3 pages fetched — a would-be 4th page is never requested.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(branches).toHaveLength(300);
  });
});

// ---------------------------------------------------------------------------
// getBranch
// ---------------------------------------------------------------------------

describe("getBranch", () => {
  it("answers the branch's head commit by name", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        commit: { sha: "abc123", commit: { tree: { sha: "t" } } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    const out = await client.getBranch({
      owner: "acme",
      repo: "widgets",
      branch: "release/2026",
    });
    expect(out).toEqual({ name: "release/2026", sha: "abc123" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/repos/acme/widgets/branches/release%2F2026",
    );
  });

  it("answers null when GitHub says the branch does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404)),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.getBranch({ owner: "acme", repo: "widgets", branch: "gone" }),
    ).resolves.toBeNull();
  });

  it("rethrows any other refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ message: "Forbidden" }, 403)),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.getBranch({ owner: "acme", repo: "widgets", branch: "main" }),
    ).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// getTree
// ---------------------------------------------------------------------------

describe("getTree", () => {
  it("resolves a commit SHA, not only a branch name", async () => {
    const sha = "0f4b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ sha, commit: { tree: { sha: "tree-1" } } }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          truncated: false,
          tree: [
            { path: ".oxagen/workspace.toml", type: "blob", sha: "b1" },
            { path: ".oxagen", type: "tree", sha: "t1" },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const paths = await client.getTree({
      owner: "acme",
      repo: "widgets",
      ref: sha,
    });

    // A commit SHA is not a branch name: reading it through /branches/ is
    // what answered 404 for every repository with a production branch.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.github.com/repos/acme/widgets/commits/${sha}`,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/git/trees/tree-1?recursive=1",
    );
    expect(paths).toEqual([".oxagen/workspace.toml"]);
  });

  it("takes a branch name through the same path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ sha: "head", commit: { tree: { sha: "tree-2" } } }),
      )
      .mockResolvedValueOnce(makeResponse({ truncated: false, tree: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.getTree({
      owner: "acme",
      repo: "widgets",
      ref: "release/2026",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/acme/widgets/commits/release%2F2026",
    );
  });
});
