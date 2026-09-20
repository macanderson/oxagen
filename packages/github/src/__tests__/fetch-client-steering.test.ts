// The calls the Context PR (ADR-061) needs beyond the read client: a
// completed check run on a commit, a pull request merge pinned to a head
// commit, a close, a branch delete, the files a head changes against its
// base, and the open pull request on a branch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../fetch-client";

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCheckRun", () => {
  it("POSTs a completed check run with its conclusion and output, and returns its id and url", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        id: 7,
        html_url: "https://github.com/o/r/runs/7",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.createCheckRun({
      owner: "o",
      repo: "r",
      name: "Oxagen · schema",
      headSha: "abc123",
      conclusion: "failure",
      title: "schema",
      summary: "unknown kind",
      startedAt: "2026-09-15T00:00:00.000Z",
      completedAt: "2026-09-15T00:00:01.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/check-runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Oxagen · schema",
      head_sha: "abc123",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-09-15T00:00:00.000Z",
      completed_at: "2026-09-15T00:00:01.000Z",
      output: { title: "schema", summary: "unknown kind" },
    });
    expect(out).toEqual({ id: 7, htmlUrl: "https://github.com/o/r/runs/7" });
  });

  it("surfaces GitHub's refusal of a non-App token as the thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse(
            { message: "Resource not accessible by integration" },
            403,
          ),
        ),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.createCheckRun({
        owner: "o",
        repo: "r",
        name: "n",
        headSha: "s",
        conclusion: "success",
        title: "t",
        summary: "s",
        startedAt: "2026-09-15T00:00:00.000Z",
        completedAt: "2026-09-15T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      "GitHub API error 403: Resource not accessible by integration",
    );
  });
});

describe("mergePullRequest", () => {
  it("PUTs the merge pinned to the head sha and returns the merge commit sha", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ sha: "7d2e91a", merged: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const out = await client.mergePullRequest({
      owner: "o",
      repo: "r",
      number: 519,
      mergeMethod: "squash",
      commitTitle: "steering: publish ctx.x",
      sha: "abc123",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/pulls/519/merge");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      merge_method: "squash",
      commit_title: "steering: publish ctx.x",
      sha: "abc123",
    });
    expect(out).toEqual({ sha: "7d2e91a", merged: true });
  });

  it("surfaces a moved head (409) with GitHub's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({ message: "Head branch was modified" }, 409),
        ),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.mergePullRequest({ owner: "o", repo: "r", number: 1, sha: "x" }),
    ).rejects.toThrow("GitHub API error 409: Head branch was modified");
  });

  it("surfaces a required-review refusal (405) with GitHub's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse(
            { message: "At least 1 approving review is required" },
            405,
          ),
        ),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.mergePullRequest({ owner: "o", repo: "r", number: 1 }),
    ).rejects.toThrow(
      "GitHub API error 405: At least 1 approving review is required",
    );
  });
});

describe("getPullRequest", () => {
  it("carries the merge commit once GitHub reports the PR merged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        makeResponse({
          number: 519,
          title: "t",
          html_url: "u",
          state: "closed",
          merged: true,
          merge_commit_sha: "7d2e91a",
          merged_at: "2026-09-15T09:16:40Z",
          user: null,
          created_at: "a",
          updated_at: "b",
          body: null,
          base: { ref: "main" },
          head: { ref: "context/x", sha: "abc123" },
        }),
      ),
    );
    const client = createGitHubClient({ token: "tok" });
    const pr = await client.getPullRequest({
      owner: "o",
      repo: "r",
      number: 519,
    });
    expect(pr).toMatchObject({
      merged: true,
      mergeCommitSha: "7d2e91a",
      mergedAt: "2026-09-15T09:16:40Z",
      headSha: "abc123",
    });
  });
});

describe("closePullRequest", () => {
  it("PATCHes the state to closed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ number: 519, html_url: "u" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    await client.closePullRequest({ owner: "o", repo: "r", number: 519 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/pulls/519");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "closed" });
  });
});

describe("deleteBranch", () => {
  it("DELETEs the ref segment by segment and accepts the bodiless 204", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.deleteBranch({ owner: "o", repo: "r", branch: "context/ctx.x" }),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/o/r/git/refs/heads/context/ctx.x",
    );
    expect(init.method).toBe("DELETE");
  });

  it("surfaces a branch already gone (422) with GitHub's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({ message: "Reference does not exist" }, 422),
        ),
    );
    const client = createGitHubClient({ token: "tok" });
    await expect(
      client.deleteBranch({ owner: "o", repo: "r", branch: "context/ctx.x" }),
    ).rejects.toThrow("GitHub API error 422: Reference does not exist");
  });
});

describe("compareCommits", () => {
  it("GETs the three-dot compare from the base to a head sha and returns every file with its previous path", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        files: [
          {
            filename: ".oxagen/rules/ctx.a.toml",
            status: "added",
            additions: 30,
            deletions: 0,
            changes: 30,
          },
          {
            filename: "docs/x.md",
            previous_filename: ".oxagen/rules/governance.toml",
            status: "renamed",
            additions: 0,
            deletions: 0,
            changes: 0,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    const files = await client.compareCommits({
      owner: "o",
      repo: "r",
      base: "main",
      head: "abc123",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/compare/main...abc123");
    expect(init.method).toBe("GET");
    expect(files.map((f) => [f.path, f.previousPath, f.status])).toEqual([
      [".oxagen/rules/ctx.a.toml", null, "added"],
      ["docs/x.md", ".oxagen/rules/governance.toml", "renamed"],
    ]);
  });
});

describe("findOpenPullRequest", () => {
  it("GETs the open pulls from owner:head into base and answers the first with its body, or null when there is none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse([
          {
            number: 519,
            html_url: "https://github.com/o/r/pull/519",
            body: "Proposal `prp_1`",
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeResponse([
          {
            number: 520,
            html_url: "https://github.com/o/r/pull/520",
            body: null,
          },
        ]),
      )
      .mockResolvedValueOnce(makeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });
    const args = { owner: "o", repo: "r", head: "context/ctx.a", base: "main" };
    expect(await client.findOpenPullRequest(args)).toEqual({
      number: 519,
      htmlUrl: "https://github.com/o/r/pull/519",
      body: "Proposal `prp_1`",
    });
    expect(await client.findOpenPullRequest(args)).toEqual({
      number: 520,
      htmlUrl: "https://github.com/o/r/pull/520",
      body: "",
    });
    expect(await client.findOpenPullRequest(args)).toBeNull();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://api.github.com/repos/o/r/pulls?state=open&head=o%3Acontext%2Fctx.a&base=main",
    );
  });
});

describe("deleteFile", () => {
  it("deletes the omitted file with its current blob SHA on the proposal branch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ sha: "blob-sha" }))
      .mockResolvedValueOnce(makeResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await createGitHubClient({ token: "tok" }).deleteFile({
      owner: "o",
      repo: "r",
      path: "skill/old.md",
      branch: "skills/example",
      message: "Remove omitted file",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/o/r/contents/skill/old.md?ref=skills%2Fexample",
    );
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({
      sha: "blob-sha",
      branch: "skills/example",
      message: "Remove omitted file",
    });
  });
});
