import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubClient,
  GitHubApiError,
  GitHubRateLimitedError,
} from "./fetch-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const ok = () =>
  new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
const limited = (headers: Record<string, string> = {}, status = 429) =>
  new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status,
    headers,
  });

describe("GitHub request limits", () => {
  it("sends a deadline and combines it with caller cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      expect(init.signal?.aborted).toBe(true);
      throw init.signal?.reason;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({
        token: "token",
        signal: controller.signal,
      }).getAuthenticatedUser(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a fetch that never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      ),
    );
    await expect(
      createGitHubClient({
        token: "token",
        timeoutMs: 5,
      }).getAuthenticatedUser(),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("honors Retry-After before retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(limited({ "retry-after": "2" }))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({ token: "token", sleep }).getAuthenticatedUser(),
    ).resolves.toEqual({ login: "octocat" });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits until the primary quota reset on a 403", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        limited(
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Date.now() / 1000 + 10),
          },
          403,
        ),
      )
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    await createGitHubClient({ token: "token", sleep }).getAuthenticatedUser();
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("bounds secondary-limit retries and preserves the final status", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => limited({}, 403));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({ token: "token", sleep }).getAuthenticatedUser(),
    ).rejects.toMatchObject({
      code: "github_rate_limited",
      status: 403,
      retryAfterMs: 240_000,
    });
    expect(sleep.mock.calls).toEqual([[60_000], [120_000]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses a long server delay instead of retrying earlier", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(limited({ "retry-after": "3600" }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({ token: "token", sleep }).getAuthenticatedUser(),
    ).rejects.toBeInstanceOf(GitHubRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry permission errors or ambiguous transport failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
      )
      .mockRejectedValueOnce(new Error("connection lost"));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "token", sleep });
    await expect(client.getAuthenticatedUser()).rejects.toBeInstanceOf(
      GitHubApiError,
    );
    await expect(client.getAuthenticatedUser()).rejects.toThrow(
      "connection lost",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });
});
