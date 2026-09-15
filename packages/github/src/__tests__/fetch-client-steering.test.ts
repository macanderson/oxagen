// The two Checks/merge calls the Context PR (ADR-061) needs: a completed
// check run on a commit, and a pull request merge.
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
  it("PUTs the merge and returns the merge commit sha", async () => {
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
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/pulls/519/merge");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      merge_method: "squash",
      commit_title: "steering: publish ctx.x",
    });
    expect(out).toEqual({ sha: "7d2e91a", merged: true });
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
