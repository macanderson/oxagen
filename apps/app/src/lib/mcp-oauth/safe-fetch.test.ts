/**
 * safe-fetch.test.ts — fault-injection tests for the timeout-bounded MCP OAuth
 * fetch wrapper. Each test simulates a way the third-party authorization server
 * can misbehave (hang, slow, error, non-OK) and asserts the wrapper degrades
 * safely rather than hanging the serverless function.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { createSafeFetch, DEFAULT_MCP_OAUTH_FETCH_TIMEOUT_MS } from "./safe-fetch";

const warn = vi.fn();
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: (...a: unknown[]) => warn(...a), info: vi.fn() },
}));

beforeEach(() => {
  warn.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSafeFetch", () => {
  it("has a sane default per-request timeout", () => {
    expect(DEFAULT_MCP_OAUTH_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_MCP_OAUTH_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("passes cache:no-store and an abort signal to the underlying fetch", async () => {
    const fake = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response("ok", { status: 200 }),
    );
    const safeFetch = createSafeFetch(fake as unknown as typeof fetch, 1000);
    await safeFetch("https://mcp.example/.well-known", { method: "GET" });
    expect(fake).toHaveBeenCalledOnce();
    const init = fake.mock.calls[0]![1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("GET");
  });

  it("aborts and rejects when the server hangs past the timeout (P0)", async () => {
    // A server that accepts the connection but never resolves — the classic
    // stall that, without a timeout, pins the function until the platform kills it.
    const fake = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("aborted"), { name: "TimeoutError" }),
            );
          });
        }),
    );
    const safeFetch = createSafeFetch(fake as unknown as typeof fetch, 5000);
    const promise = safeFetch("https://slow.example/token");
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    // The timeout must be observable, not swallowed.
    expect(warn).toHaveBeenCalled();
    const [, msg] = warn.mock.calls[0] as [unknown, string];
    expect(msg).toContain("timed out");
  });

  it("resolves normally when the server responds before the timeout", async () => {
    const fake = vi.fn(async () => new Response("body", { status: 200 }));
    const safeFetch = createSafeFetch(fake, 5000);
    const res = await safeFetch("https://fast.example/token");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
    expect(warn).not.toHaveBeenCalled();
  });

  it("pre-drains a non-OK body and returns a plain Response (no cancel() hang)", async () => {
    const fake = vi.fn(
      async () => new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    const safeFetch = createSafeFetch(fake, 5000);
    const res = await safeFetch(
      "https://mcp.example/.well-known/oauth-protected-resource",
    );
    expect(res.status).toBe(404);
    expect(res.statusText).toBe("Not Found");
    // Body already read into memory — reading it again must not hang or throw.
    await expect(res.text()).resolves.toBe("not found");
  });

  it("surfaces a network error as observable and rethrows it", async () => {
    const fake = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const safeFetch = createSafeFetch(fake, 5000);
    await expect(safeFetch("https://down.example/token")).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(warn).toHaveBeenCalled();
    const [, msg] = warn.mock.calls[0] as [unknown, string];
    expect(msg).toContain("network error");
  });

  it("honors a caller-supplied abort signal even before the timeout fires", async () => {
    const fake = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const controller = new AbortController();
    const safeFetch = createSafeFetch(fake as unknown as typeof fetch, 60_000);
    const promise = safeFetch("https://slow.example/token", {
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toThrow();
    controller.abort();
    await assertion;
  });
});
