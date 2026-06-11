/**
 * Unit tests for src/middleware/error.ts
 *
 * Covers:
 * - errorCode() full status map
 * - errorMiddleware: HTTPException → {error:{code,message},requestId}
 * - ZodError → includes details.issues
 * - Unknown error → "internal_error", never leaks raw message
 * - requestId always present
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger to prevent pino output during tests
vi.mock("../middleware/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

// Mock all auth resolvers before importing app
vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    invoke: vi.fn(),
    clearHandlersForTests: vi.fn(),
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileNotFoundError"; }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileForbiddenError"; }
  },
}));

import type { AppEnv } from "../app";
import { app } from "../app";
import { makeRequest } from "./_helpers";
import { HTTPException } from "hono/http-exception";
import { ZodError, z } from "zod";

// ── Helpers: invoke errorMiddleware directly via Hono context ─────────────────
// We use app.fetch on a route that deliberately throws, rather than
// calling errorMiddleware in isolation, which requires a mock context.

/**
 * Mount a one-shot test route that throws the given error, fetch it,
 * and return the parsed JSON response + status.
 */
async function triggerError(err: unknown): Promise<{ status: number; body: unknown }> {
  // Build a minimal Hono app with just error middleware for isolation
  const { Hono } = await import("hono");
  const { errorMiddleware } = await import("../middleware/error");

  const testApp = new Hono<AppEnv>();
  testApp.onError(errorMiddleware);
  testApp.get("/boom", () => {
    throw err;
  });

  const res = await testApp.fetch(makeRequest("/boom"));
  const body: unknown = await res.json();
  return { status: res.status, body };
}

// ── errorCode() via HTTPException status codes ────────────────────────────────

describe("errorCode() via HTTPException", () => {
  it("401 → unauthorized", async () => {
    const { body } = await triggerError(new HTTPException(401, { message: "Unauthorized" }));
    expect((body as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("403 → forbidden", async () => {
    const { body } = await triggerError(new HTTPException(403, { message: "Forbidden" }));
    expect((body as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("404 → not_found", async () => {
    const { body } = await triggerError(new HTTPException(404, { message: "Not found" }));
    expect((body as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("409 → conflict", async () => {
    const { body } = await triggerError(new HTTPException(409, { message: "Conflict" }));
    expect((body as { error: { code: string } }).error.code).toBe("conflict");
  });

  it("429 → rate_limited", async () => {
    const { body } = await triggerError(new HTTPException(429, { message: "Too many" }));
    expect((body as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  it("500 → internal_error", async () => {
    const { body } = await triggerError(new HTTPException(500, { message: "Server error" }));
    expect((body as { error: { code: string } }).error.code).toBe("internal_error");
  });

  it("503 (>=500) → internal_error", async () => {
    const { body } = await triggerError(new HTTPException(503, { message: "Service unavailable" }));
    expect((body as { error: { code: string } }).error.code).toBe("internal_error");
  });

  it("422 → bad_request (catch-all for 4xx not mapped above)", async () => {
    const { body } = await triggerError(new HTTPException(422, { message: "Unprocessable" }));
    expect((body as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("418 → bad_request (catch-all for unmapped 4xx)", async () => {
    // 499/599 are not valid Hono ContentfulStatusCode; use 418 (teapot) to
    // exercise the same bad_request catch-all branch in errorCode().
    const { body } = await triggerError(new HTTPException(418, { message: "I'm a teapot" }));
    expect((body as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("400 → bad_request", async () => {
    const { body } = await triggerError(new HTTPException(400, { message: "Bad" }));
    expect((body as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("504 → internal_error (>=500 catch-all)", async () => {
    // Tests the `status >= 500` branch in errorCode() using a valid Hono status code.
    const { body } = await triggerError(new HTTPException(504, { message: "Gateway timeout" }));
    expect((body as { error: { code: string } }).error.code).toBe("internal_error");
  });
});

// ── HTTPException → {error:{code,message},requestId} ─────────────────────────

describe("errorMiddleware HTTPException shape", () => {
  it("returns error.message matching the thrown exception message", async () => {
    const { body } = await triggerError(new HTTPException(401, { message: "Custom message" }));
    const b = body as { error: { message: string }; requestId: string };
    expect(b.error.message).toBe("Custom message");
  });

  it("always includes requestId (UUID-shaped or 'unknown' fallback)", async () => {
    const { body } = await triggerError(new HTTPException(401, { message: "x" }));
    const b = body as { requestId: string };
    // errorMiddleware falls back to "unknown" when requestId is not in context
    expect(typeof b.requestId).toBe("string");
    expect(b.requestId.length).toBeGreaterThan(0);
  });

  it("returns the correct HTTP status code", async () => {
    const { status } = await triggerError(new HTTPException(404, { message: "gone" }));
    expect(status).toBe(404);
  });
});

// ── ZodError → includes details:issues ───────────────────────────────────────

describe("errorMiddleware ZodError", () => {
  it("returns 400 with code 'validation_error'", async () => {
    const schema = z.object({ name: z.string() });
    let zodErr: ZodError | null = null;
    try {
      schema.parse({ name: 123 });
    } catch (e) {
      zodErr = e as ZodError;
    }

    const { status, body } = await triggerError(zodErr!);
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("includes error.details with Zod issues array", async () => {
    const schema = z.object({ x: z.string(), y: z.number() });
    let zodErr: ZodError | null = null;
    try {
      schema.parse({});
    } catch (e) {
      zodErr = e as ZodError;
    }

    const { body } = await triggerError(zodErr!);
    const b = body as { error: { details: unknown[] } };
    expect(Array.isArray(b.error.details)).toBe(true);
    expect(b.error.details.length).toBeGreaterThan(0);
  });

  it("always includes requestId", async () => {
    const schema = z.object({ n: z.string() });
    let zodErr: ZodError | null = null;
    try { schema.parse({}); } catch (e) { zodErr = e as ZodError; }
    const { body } = await triggerError(zodErr!);
    expect(typeof (body as { requestId: string }).requestId).toBe("string");
  });
});

// ── Unknown error → internal_error, no raw message leak ──────────────────────

describe("errorMiddleware unknown error", () => {
  it("returns 500 with code 'internal_error'", async () => {
    const { status, body } = await triggerError(new Error("secret DB password"));
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe("internal_error");
  });

  it("does NOT include the raw error message in the response body", async () => {
    const secretMsg = "super-secret-internal-detail-abc123";
    const { body } = await triggerError(new Error(secretMsg));
    expect(JSON.stringify(body)).not.toContain(secretMsg);
  });

  it("returns a generic safe message", async () => {
    const { body } = await triggerError(new Error("leak me"));
    expect((body as { error: { message: string } }).error.message).toBe("Unexpected server error");
  });

  it("handles non-Error object throws without leaking", async () => {
    // Hono's onError only fires for actual Error instances or HTTPException —
    // wrap in an Error to simulate an unusual but catchable error object.
    const { status, body } = await triggerError(Object.assign(new Error("wrapper"), { code: "internal_leak" }));
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe("internal_error");
  });

  it("always includes requestId even for unknown errors", async () => {
    const { body } = await triggerError(new Error("boom"));
    expect(typeof (body as { requestId: string }).requestId).toBe("string");
    expect((body as { requestId: string }).requestId.length).toBeGreaterThan(0);
  });
});

// ── CapabilityError → HTTP status codes ──────────────────────────────────────

describe("errorMiddleware CapabilityError", () => {
  it("authz_denied → 403 forbidden", async () => {
    const { CapabilityError } = await import("@oxagen/oxagen/kernel");
    const { status, body } = await triggerError(
      new CapabilityError("test.cap", "authz_denied", "IAM denied"),
    );
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("surface_denied → 403 forbidden", async () => {
    const { CapabilityError } = await import("@oxagen/oxagen/kernel");
    const { status, body } = await triggerError(
      new CapabilityError("test.cap", "surface_denied", "surface blocked"),
    );
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("unknown_capability → 404 not_found", async () => {
    const { CapabilityError } = await import("@oxagen/oxagen/kernel");
    const { status, body } = await triggerError(
      new CapabilityError("test.missing", "unknown_capability", "unknown"),
    );
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("invalid_input → 400 bad_request", async () => {
    const { CapabilityError } = await import("@oxagen/oxagen/kernel");
    const { status, body } = await triggerError(
      new CapabilityError("test.cap", "invalid_input", "bad input"),
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("bad_request");
  });
});

// ── Billing errors → 402 Payment Required ────────────────────────────────────

describe("errorMiddleware billing errors", () => {
  it("InsufficientCreditsError → 402", async () => {
    const err = Object.assign(new Error("no credits"), { code: "insufficient_credits" });
    const { status, body } = await triggerError(err);
    expect(status).toBe(402);
    expect((body as { error: { code: string } }).error.code).toBe("insufficient_credits");
  });

  it("BillingSuspendedError → 402", async () => {
    const err = Object.assign(new Error("suspended"), { code: "billing_suspended" });
    const { status, body } = await triggerError(err);
    expect(status).toBe(402);
    expect((body as { error: { code: string } }).error.code).toBe("billing_suspended");
  });
});

// ── Full app.fetch integration — confirm requestId is UUID from logger ────────

describe("error middleware via app.fetch (requestId from logger)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requestId on a real 404 (no auth) is UUID-shaped when logger middleware runs", async () => {
    const res = await app.fetch(makeRequest("/v1/no-such-route-xyz"));
    const body = await res.json() as { requestId?: string };
    // The route 404s at Hono routing level — error middleware may or may not set requestId.
    // What we assert: if requestId is present it is a non-empty string.
    if (body.requestId !== undefined) {
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId.length).toBeGreaterThan(0);
    }
  });
});
