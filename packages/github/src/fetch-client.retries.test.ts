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

const fork = () =>
  new Response(
    JSON.stringify({
      full_name: "octocat/project",
      html_url: "https://github.com/octocat/project",
      default_branch: "main",
    }),
    { status: 200 },
  );
const unavailable = () =>
  new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
const forkArgs = { owner: "upstream", repo: "project" };

describe("fork polling cancellation and limits", () => {
  it("preserves cancellation before the first availability request", async () => {
    const controller = new AbortController();
    const reason = { cancelledBy: "operator" };
    const response = fork();
    const read = response.json.bind(response);
    vi.spyOn(response, "json").mockImplementation(async () => {
      const body = await read();
      controller.abort(reason);
      return body;
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({
        token: "token",
        signal: controller.signal,
      }).forkRepo(forkArgs),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation during an availability request", async () => {
    const controller = new AbortController();
    const reason = new Error("operator stopped polling");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fork())
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        controller.abort(reason);
        throw init.signal?.reason;
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({
        token: "token",
        signal: controller.signal,
      }).forkRepo(forkArgs),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a timed-out availability request without another poll", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fork())
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({ token: "token", timeoutMs: 5 }).forkRepo(forkArgs),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not restart an exhausted rate-limit budget during polling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fork())
      .mockImplementation(async () => limited({ "retry-after": "1" }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({ token: "token", sleep }).forkRepo(forkArgs),
    ).rejects.toBeInstanceOf(GitHubRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
  });

  it.each(["rate limit", "availability"])(
    "cancels a pending %s wait without waiting for injected sleep",
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error("stop waiting");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const add = vi.spyOn(controller.signal, "addEventListener");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fork())
        .mockResolvedValueOnce(
          kind === "rate limit" ? limited() : unavailable(),
        );
      const sleep = vi.fn(() => {
        controller.abort(reason);
        return new Promise<void>(() => undefined);
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        createGitHubClient({
          token: "token",
          signal: controller.signal,
          sleep,
        }).forkRepo(forkArgs),
      ).rejects.toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
      expect(listener).toBeTypeOf("function");
      expect(remove).toHaveBeenCalledWith("abort", listener);
    },
  );

  it("clears the default wait timer on cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("stop waiting");
    const fetchMock = vi.fn().mockImplementation(async () => limited());
    vi.stubGlobal("fetch", fetchMock);
    const pending = createGitHubClient({
      token: "token",
      signal: controller.signal,
    }).getAuthenticatedUser();
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes wait listeners on success and preserves 404 polling", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fork())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(fork());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({
        token: "token",
        signal: controller.signal,
        sleep: async () => undefined,
      }).forkRepo(forkArgs),
    ).resolves.toEqual({
      fullName: "octocat/project",
      htmlUrl: "https://github.com/octocat/project",
      defaultBranch: "main",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", listener);
  });

  it("removes wait listeners when the injected sleep rejects", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("sleep failed");
    const fetchMock = vi.fn().mockImplementation(async () => limited());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubClient({
        token: "token",
        signal: controller.signal,
        sleep: async () => {
          throw reason;
        },
      }).getAuthenticatedUser(),
    ).rejects.toBe(reason);
    const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", listener);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
