import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubRateLimitedError } from "../fetch-client";
import {
  createGithubRest,
  RATE_LIMIT_RETRY_MS,
  seg,
  type HttpFetch,
} from "./http";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that answers every request with one status and body, and records what it was sent. */
function recorder(status: number, text: string): { sent: Sent[]; fetch: HttpFetch } {
  const sent: Sent[] = [];
  const fetch: HttpFetch = (url, init) => {
    sent.push({ url, ...init });
    return Promise.resolve({ status, text: () => Promise.resolve(text) });
  };
  return { sent, fetch };
}

function client(status: number, text: string) {
  const { sent, fetch } = recorder(status, text);
  return { sent, rest: createGithubRest({ token: "t0k3n", fetch }) };
}

async function rejection<E extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof type) return e;
    throw e;
  }
  throw new Error("The request resolved, and the test expected it to throw.");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGithubRest", () => {
  it("returns the parsed body of a 2xx answer", async () => {
    const { rest } = client(200, JSON.stringify({ id: 7, name: "r" }));
    const res = await rest.request<{ id: number; name: string }>("GET", "/repos/o/r");
    expect(res).toEqual({ status: 200, data: { id: 7, name: "r" }, message: null });
  });

  it("returns null data for an empty 2xx body", async () => {
    const { rest } = client(204, "");
    const res = await rest.request("PUT", "/x", { a: 1 });
    expect(res).toEqual({ status: 204, data: null, message: null });
  });

  it("returns null data for a 2xx body that is not JSON", async () => {
    const { rest } = client(200, "<html>");
    const res = await rest.request("GET", "/x");
    expect(res.data).toBeNull();
  });

  it("returns a status the caller accepts with GitHub's message and no data", async () => {
    const { rest } = client(404, JSON.stringify({ message: "Not Found" }));
    const res = await rest.request("GET", "/repos/o/r", undefined, [404]);
    expect(res).toEqual({ status: 404, data: null, message: "Not Found" });
  });

  it("names the status when an accepted answer has no message", async () => {
    const { rest } = client(304, "");
    const res = await rest.request("PUT", "/x", undefined, [304]);
    expect(res).toEqual({ status: 304, data: null, message: "status 304" });
  });

  it("throws GitHubApiError with the message and every error joined", async () => {
    const { rest } = client(
      422,
      JSON.stringify({
        message: "Validation Failed",
        errors: ["name is taken", { message: "too long" }, { code: "custom" }, 7, null],
      }),
    );
    const err = await rejection(rest.request("POST", "/orgs/o/repos", {}), GitHubApiError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitedError);
    expect(err.status).toBe(422);
    expect(err.message).toBe("GitHub API error 422: Validation Failed: name is taken: too long");
  });

  it("reads the errors when the body has no message", async () => {
    const { rest } = client(422, JSON.stringify({ errors: [{ message: "bad ref" }] }));
    const err = await rejection(rest.request("POST", "/x", {}), GitHubApiError);
    expect(err.message).toBe("GitHub API error 422: bad ref");
  });

  it("names the status when the error body carries no message", async () => {
    for (const text of ["", "{}", "[]", '"plain text"', "not json"]) {
      const { rest } = client(500, text);
      const err = await rejection(rest.request("GET", "/x"), GitHubApiError);
      expect(err.status).toBe(500);
      expect(err.message).toBe("GitHub API error 500: status 500");
    }
  });

  it("throws GitHubRateLimitedError on a 429 even when the caller accepts 429", async () => {
    const { rest } = client(429, JSON.stringify({ message: "slow down" }));
    const err = await rejection(
      rest.request("GET", "/x", undefined, [429]),
      GitHubRateLimitedError,
    );
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(RATE_LIMIT_RETRY_MS);
    expect(err.code).toBe("github_rate_limited");
  });

  it("throws GitHubRateLimitedError on a rate limit 403 even when the caller accepts 403", async () => {
    const { rest } = client(
      403,
      JSON.stringify({ message: "API rate limit exceeded for installation ID 77." }),
    );
    const err = await rejection(
      rest.request("GET", "/user/installations", undefined, [401, 403]),
      GitHubRateLimitedError,
    );
    expect(err.status).toBe(403);
    expect(err.retryAfterMs).toBe(60_000);
  });

  it("returns an accepted 403 that is not a rate limit", async () => {
    const { rest } = client(
      403,
      JSON.stringify({ message: "Resource not accessible by integration" }),
    );
    const res = await rest.request("GET", "/x", undefined, [403]);
    expect(res).toEqual({
      status: 403,
      data: null,
      message: "Resource not accessible by integration",
    });
  });

  it("throws GitHubApiError for a 403 that is neither accepted nor a rate limit", async () => {
    const { rest } = client(403, JSON.stringify({ message: "Forbidden" }));
    const err = await rejection(rest.request("GET", "/x"), GitHubApiError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitedError);
    expect(err.status).toBe(403);
  });

  it("sends the default headers and no body when the body is left out", async () => {
    const { sent, rest } = client(200, "{}");
    await rest.request("GET", "/repos/acme/r");
    expect(sent).toHaveLength(1);
    const [first] = sent;
    expect(first?.url).toBe("https://api.github.com/repos/acme/r");
    expect(first?.method).toBe("GET");
    expect(first?.headers).toEqual({
      Authorization: "Bearer t0k3n",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    });
    expect(first !== undefined && "body" in first).toBe(false);
  });

  it("sends the body as JSON", async () => {
    const { sent, rest } = client(201, "{}");
    await rest.request("POST", "/x", { name: "r", private: true });
    expect(sent[0]?.body).toBe('{"name":"r","private":true}');
  });

  it("sends a null body as JSON null", async () => {
    const { sent, rest } = client(200, "{}");
    await rest.request("PATCH", "/x", null);
    expect(sent[0]?.body).toBe("null");
  });

  it("joins a base URL that ends in a slash without doubling it", async () => {
    const { sent, fetch } = recorder(200, "{}");
    const rest = createGithubRest({
      token: "t",
      baseUrl: "https://ghe.example.com/api/v3/",
      fetch,
    });
    await rest.request("GET", "/user");
    expect(sent[0]?.url).toBe("https://ghe.example.com/api/v3/user");
  });

  it("uses the global fetch when none is passed", async () => {
    const globalFetch = vi.fn(() =>
      Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":true}') }),
    );
    vi.stubGlobal("fetch", globalFetch);
    const rest = createGithubRest({ token: "t" });
    const res = await rest.request<{ ok: boolean }>("GET", "/rate_limit");
    expect(res.data).toEqual({ ok: true });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch.mock.calls[0]).toEqual([
      "https://api.github.com/rate_limit",
      expect.objectContaining({ method: "GET" }),
    ]);
  });
});

describe("seg", () => {
  it("percent-encodes one path segment", () => {
    expect(seg("acme")).toBe("acme");
    expect(seg("a/b c")).toBe("a%2Fb%20c");
    expect(seg("feature/x?y#z")).toBe("feature%2Fx%3Fy%23z");
  });

  it("writes a number as its digits", () => {
    expect(seg(42)).toBe("42");
  });
});
