import { describe, expect, it, vi } from "vitest";
import {
  githubPath,
  githubRest,
  recordSteeringDeployment,
  type GitHubRest,
} from "./deployments";
import { GitHubApiError } from "./fetch-client";

type Call = { url: string; init: RequestInit };

function fetchReturning(...responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("githubRest", () => {
  it("sends the token, API version, and JSON body to the API base URL", async () => {
    const { fetch, calls } = fetchReturning(json(201, { sha: "abc" }));
    const rest = githubRest({ token: "t0k", fetch });
    const res = await rest.request<{ sha: string }>("POST", "/repos/a/b/merges", {
      base: "steering/x",
      head: "main",
    });
    expect(res).toEqual({ status: 201, data: { sha: "abc" } });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/a/b/merges");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ base: "steering/x", head: "main" }),
    );
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer t0k",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses an Enterprise base URL without doubling the slash, and sends no body on a GET", async () => {
    const { fetch, calls } = fetchReturning(json(200, []));
    await githubRest({
      token: "t",
      baseUrl: "https://ghe.example.com/api/v3/",
      fetch,
    }).request("GET", "/repos/a/b/pulls/1/reviews");
    expect(calls[0]?.url).toBe(
      "https://ghe.example.com/api/v3/repos/a/b/pulls/1/reviews",
    );
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("answers a 204 with no data", async () => {
    const { fetch } = fetchReturning(new Response(null, { status: 204 }));
    const res = await githubRest({ token: "t", fetch }).request(
      "POST",
      "/repos/a/b/merges",
      {},
    );
    expect(res).toEqual({ status: 204, data: undefined });
  });

  it("throws GitHubApiError with GitHub's message and the status", async () => {
    const { fetch } = fetchReturning(json(409, { message: "Merge conflict" }));
    const err = await githubRest({ token: "t", fetch })
      .request("POST", "/repos/a/b/merges", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({
      status: 409,
      message: "GitHub API error 409: Merge conflict",
    });
  });

  it("falls back to the status text when the error body is unreadable", async () => {
    const { fetch } = fetchReturning(
      new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(
      githubRest({ token: "t", fetch }).request("GET", "/x"),
    ).rejects.toMatchObject({
      status: 502,
      message: "GitHub API error 502: Bad Gateway",
    });
  });
});

describe("githubPath", () => {
  it("encodes each segment and keeps the slashes of a branch name", () => {
    expect(githubPath("steering/memory/a b")).toBe("steering/memory/a%20b");
    expect(githubPath("a#1", "b")).toBe("a%231/b");
  });
});

describe("recordSteeringDeployment", () => {
  const input = {
    owner: "a-intel",
    repo: "platform",
    sha: "merge1",
    environment: "steering",
    description: "Steering version 3 (#12)",
  };

  it("creates the deployment at the merge commit, then marks it successful", async () => {
    const { fetch, calls } = fetchReturning(
      json(201, { id: 77 }),
      json(201, { id: 1 }),
    );
    const out = await recordSteeringDeployment(
      githubRest({ token: "t", fetch }),
      input,
    );
    expect(out).toEqual({
      id: 77,
      url: "https://github.com/a-intel/platform/deployments/steering",
    });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/a-intel/platform/deployments",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      ref: "merge1",
      environment: "steering",
      description: "Steering version 3 (#12)",
      auto_merge: false,
      required_contexts: [],
    });
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/a-intel/platform/deployments/77/statuses",
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      state: "success",
      description: "Steering version 3 (#12)",
      auto_inactive: true,
    });
  });

  it("refuses a 202, where GitHub started a merge instead of a deployment", async () => {
    const { fetch, calls } = fetchReturning(
      json(202, { message: "Auto-merged main into topic branch." }),
    );
    await expect(
      recordSteeringDeployment(githubRest({ token: "t", fetch }), input),
    ).rejects.toMatchObject({
      status: 202,
      message: "GitHub API error 202: Auto-merged main into topic branch.",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses an answer with no deployment id, and says so when GitHub gives no reason", async () => {
    const rest: GitHubRest = {
      request: vi.fn(async () => ({ status: 201, data: {} })),
    } as unknown as GitHubRest;
    await expect(recordSteeringDeployment(rest, input)).rejects.toMatchObject({
      status: 201,
      message: "GitHub API error 201: GitHub did not create the deployment",
    });
  });

  it("passes a refused deployment through as GitHubApiError", async () => {
    const { fetch } = fetchReturning(
      json(403, { message: "Resource not accessible by integration" }),
    );
    await expect(
      recordSteeringDeployment(githubRest({ token: "t", fetch }), input),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
