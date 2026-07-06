/**
 * API client diagnostics — proves the rich `error` debug entry the CLI emits on
 * a failed request. The motivating incident: production returned a 500
 * `FUNCTION_INVOCATION_FAILED` on every route, and `OXAGEN_CLI_DEBUG=1` logged
 * only `{ path, status, body }` — no way to pivot to the server-side stack. The
 * client can never see the server's filenames/line numbers, so the next best
 * thing is captured here: the `x-vercel-id` request id, the error class, full
 * method+URL, latency, a local call stack, and an actionable hint.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Valid auth/scope so requireApiContext resolves and we reach the fetch seam.
vi.mock("../config.js", () => ({
  getApiUrl: () => "https://api.oxagen.sh",
  getToken: () => "tok_test",
  getOrgId: () => "org-slug",
  getWorkspaceId: () => "ws-slug",
}));

// Capture debug entries without touching disk. Hoisted (vi.mock lifts its
// factory above module top-level, so the spy must be created in vi.hoisted).
const { debugLog } = vi.hoisted(() => ({
  debugLog: vi.fn((_category: string, _event: string, _data?: unknown) => Promise.resolve()),
}));
vi.mock("../debug-log.js", () => ({
  debugLog,
  isDebugEnabled: () => true,
}));

import { apiGetOrThrow, ApiError } from "../api.js";

/** The last `debugLog("error", …)` payload, or undefined if none was logged. */
function lastErrorEntry(): Record<string, unknown> | undefined {
  const call = [...debugLog.mock.calls].reverse().find((c) => c[0] === "error");
  return call?.[2] as Record<string, unknown> | undefined;
}

const originalFetch = globalThis.fetch;

describe("apiGetOrThrow error diagnostics", () => {
  beforeEach(() => debugLog.mockClear());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("captures x-vercel-id, headers, timing, call stack, and a hint on a 5xx", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("A server error has occurred\n\nFUNCTION_INVOCATION_FAILED", {
        status: 500,
        statusText: "Internal Server Error",
        headers: {
          "x-vercel-id": "sfo1::iad1::abc123-1700000000000-deadbeef",
          "x-vercel-error": "FUNCTION_INVOCATION_FAILED",
          "content-type": "text/plain",
        },
      });
    }) as typeof fetch;

    await expect(apiGetOrThrow("agent/file/lock/list")).rejects.toBeInstanceOf(ApiError);

    const entry = lastErrorEntry();
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      method: "GET",
      url: "https://api.oxagen.sh/v1/org-slug/ws-slug/agent/file/lock/list",
      path: "agent/file/lock/list",
      status: 500,
      statusText: "Internal Server Error",
      body: expect.stringContaining("FUNCTION_INVOCATION_FAILED"),
    });
    // The pivot key to the server-side stack, plus the platform error class.
    expect((entry?.headers as Record<string, string>)["x-vercel-id"]).toBe(
      "sfo1::iad1::abc123-1700000000000-deadbeef",
    );
    expect((entry?.headers as Record<string, string>)["x-vercel-error"]).toBe(
      "FUNCTION_INVOCATION_FAILED",
    );
    expect(typeof entry?.durationMs).toBe("number");
    expect(typeof entry?.callStack).toBe("string");
    // A 5xx hint must point the engineer at the request id + runtime logs.
    expect(String(entry?.hint)).toMatch(/request id|runtime logs/i);
  });

  it("surfaces the trace id on the thrown ApiError (message + field)", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("boom", {
        status: 500,
        headers: { "x-vercel-id": "sfo1::trace-xyz" },
      });
    }) as typeof fetch;

    let err: unknown;
    try {
      await apiGetOrThrow("agent/file/lock/list");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.traceId).toBe("sfo1::trace-xyz");
    expect(apiErr.message).toContain("sfo1::trace-xyz");
  });

  it("logs a stack-bearing network entry when fetch itself throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    }) as typeof fetch;

    let err: unknown;
    try {
      await apiGetOrThrow("agent/file/lock/list");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);

    const entry = lastErrorEntry();
    expect(entry?.method).toBe("GET");
    // The sanitized Error keeps { name, message, stack } — a genuinely local trace.
    const logged = entry?.error as { message?: string } | undefined;
    expect(logged?.message).toContain("ECONNREFUSED");
  });
});
