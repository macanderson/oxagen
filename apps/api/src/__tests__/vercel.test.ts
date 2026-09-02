/**
 * Regression test for the Vercel serverless entrypoint bootstrap guard.
 *
 * A bare `const ready = bootstrap()` left the promise's rejection unhandled
 * until the first request — so a cold-start bootstrap failure surfaced as a
 * Node `unhandledRejection`, which Vercel turns into FUNCTION_INVOCATION_FAILED
 * (the original opaque 500 on POST /v1/.../connections and the GitHub webhook).
 *
 * These tests pin the fixed behavior: the rejection is captured synchronously
 * (never unhandled) and a failed bootstrap yields a clean 503 instead of a crash.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHonoHandler, state } = vi.hoisted(() => ({
  mockHonoHandler: vi.fn(),
  state: { bootstrapImpl: () => Promise.resolve() as Promise<void> },
}));

// Mock specifiers are resolved relative to THIS test file (src/__tests__), so
// "../app"/"../bootstrap" target the same src/* modules vercel.ts imports.
vi.mock("../app", () => ({ app: {} }));
vi.mock("@hono/node-server/vercel", () => ({ handle: () => mockHonoHandler }));
vi.mock("../bootstrap", () => ({ bootstrap: () => state.bootstrapImpl() }));

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(k: string, v: string): void;
  end(b?: string): void;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      if (b) this.body = b;
    },
  };
}

describe("vercel entrypoint bootstrap guard", () => {
  beforeEach(() => {
    vi.resetModules();
    mockHonoHandler.mockReset();
    state.bootstrapImpl = () => Promise.resolve();
  });

  it("returns a clean 503 and skips the app when bootstrap rejects", async () => {
    state.bootstrapImpl = () => Promise.reject(new Error("loadEnv failed"));
    const mod = await import("../vercel");
    const res = makeRes();

    await (mod.default as (req: unknown, res: unknown) => Promise<void>)(
      {},
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body).error.code).toBe("service_unavailable");
    expect(mockHonoHandler).not.toHaveBeenCalled();
  });

  it("delegates to the hono handler when bootstrap resolves", async () => {
    state.bootstrapImpl = () => Promise.resolve();
    const mod = await import("../vercel");
    const res = makeRes();
    const req = { method: "GET" };

    await (mod.default as (req: unknown, res: unknown) => Promise<void>)(
      req,
      res,
    );

    expect(mockHonoHandler).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("never emits an unhandledRejection when bootstrap rejects at module load", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      state.bootstrapImpl = () =>
        Promise.reject(new Error("assertRlsConnectionSafe failed"));
      await import("../vercel");
      // Flush microtasks + a macrotask so any unhandled rejection would fire.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
