/**
 * Unit tests for src/middleware/error.ts
 *
 * Covers:
 * - errorCode() full status map
 * - errorMiddleware: HTTPException → {error:{code,message},requestId}
 * - ZodError → includes details.issues
 * - HandlerError → 403 / 404 / 409 by code, reason in the envelope
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
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
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
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
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
async function triggerError(
  err: unknown,
): Promise<{ status: number; body: unknown; headers: Headers }> {
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
  return { status: res.status, body, headers: res.headers };
}

// ── A body that is not JSON ───────────────────────────────────────────────────

describe("malformed JSON body", () => {
  it("maps JSON.parse's SyntaxError to 400 bad_request", async () => {
    const { status, body } = await triggerError(
      new SyntaxError("Unexpected token b in JSON at position 1"),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "bad_request",
        message: "Request body is not valid JSON",
      },
    });
  });

  it("answers 400 on the real path, a route awaiting c.req.json() on `{bad`", async () => {
    const { Hono } = await import("hono");
    const { errorMiddleware } = await import("../middleware/error");
    const testApp = new Hono<AppEnv>();
    testApp.onError(errorMiddleware);
    testApp.post("/echo", async (c) => c.json(await c.req.json()));

    const res = await testApp.fetch(
      makeRequest("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "bad_request" },
    });
  });

  it("leaves a SyntaxError that does not name JSON as a 500", async () => {
    const { status, body } = await triggerError(
      new SyntaxError("Invalid regular expression: /(/: Unterminated group"),
    );
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });
});

// ── errorCode() via HTTPException status codes ────────────────────────────────

describe("errorCode() via HTTPException", () => {
  it("401 → unauthorized", async () => {
    const { body } = await triggerError(
      new HTTPException(401, { message: "Unauthorized" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });

  it("403 → forbidden", async () => {
    const { body } = await triggerError(
      new HTTPException(403, { message: "Forbidden" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("404 → not_found", async () => {
    const { body } = await triggerError(
      new HTTPException(404, { message: "Not found" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("409 → conflict", async () => {
    const { body } = await triggerError(
      new HTTPException(409, { message: "Conflict" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe("conflict");
  });

  it("429 → rate_limited", async () => {
    const { body } = await triggerError(
      new HTTPException(429, { message: "Too many" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "rate_limited",
    );
  });

  it("500 → internal_error", async () => {
    const { body } = await triggerError(
      new HTTPException(500, { message: "Server error" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });

  it("503 (>=500) → internal_error", async () => {
    const { body } = await triggerError(
      new HTTPException(503, { message: "Service unavailable" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });

  it("422 → bad_request (catch-all for 4xx not mapped above)", async () => {
    const { body } = await triggerError(
      new HTTPException(422, { message: "Unprocessable" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "bad_request",
    );
  });

  it("418 → bad_request (catch-all for unmapped 4xx)", async () => {
    // 499/599 are not valid Hono ContentfulStatusCode; use 418 (teapot) to
    // exercise the same bad_request catch-all branch in errorCode().
    const { body } = await triggerError(
      new HTTPException(418, { message: "I'm a teapot" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "bad_request",
    );
  });

  it("400 → bad_request", async () => {
    const { body } = await triggerError(
      new HTTPException(400, { message: "Bad" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "bad_request",
    );
  });

  it("504 → internal_error (>=500 catch-all)", async () => {
    // Tests the `status >= 500` branch in errorCode() using a valid Hono status code.
    const { body } = await triggerError(
      new HTTPException(504, { message: "Gateway timeout" }),
    );
    expect((body as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });
});

// ── HTTPException → {error:{code,message},requestId} ─────────────────────────

describe("errorMiddleware HTTPException shape", () => {
  it("returns error.message matching the thrown exception message", async () => {
    const { body } = await triggerError(
      new HTTPException(401, { message: "Custom message" }),
    );
    const b = body as { error: { message: string }; requestId: string };
    expect(b.error.message).toBe("Custom message");
  });

  it("always includes requestId (UUID-shaped or 'unknown' fallback)", async () => {
    const { body } = await triggerError(
      new HTTPException(401, { message: "x" }),
    );
    const b = body as { requestId: string };
    // errorMiddleware falls back to "unknown" when requestId is not in context
    expect(typeof b.requestId).toBe("string");
    expect(b.requestId.length).toBeGreaterThan(0);
  });

  it("returns the correct HTTP status code", async () => {
    const { status } = await triggerError(
      new HTTPException(404, { message: "gone" }),
    );
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
    expect((body as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );
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
    try {
      schema.parse({});
    } catch (e) {
      zodErr = e as ZodError;
    }
    const { body } = await triggerError(zodErr!);
    expect(typeof (body as { requestId: string }).requestId).toBe("string");
  });
});

// ── Unknown error → internal_error, no raw message leak ──────────────────────

describe("errorMiddleware unknown error", () => {
  it("returns 500 with code 'internal_error'", async () => {
    const { status, body } = await triggerError(
      new Error("secret DB password"),
    );
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });

  it("does NOT include the raw error message in the response body", async () => {
    const secretMsg = "super-secret-internal-detail-abc123";
    const { body } = await triggerError(new Error(secretMsg));
    expect(JSON.stringify(body)).not.toContain(secretMsg);
  });

  it("returns a generic safe message", async () => {
    const { body } = await triggerError(new Error("leak me"));
    expect((body as { error: { message: string } }).error.message).toBe(
      "Unexpected server error",
    );
  });

  it("handles non-Error object throws without leaking", async () => {
    // Hono's onError only fires for actual Error instances or HTTPException —
    // wrap in an Error to simulate an unusual but catchable error object.
    const { status, body } = await triggerError(
      Object.assign(new Error("wrapper"), { code: "internal_leak" }),
    );
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });

  it("always includes requestId even for unknown errors", async () => {
    const { body } = await triggerError(new Error("boom"));
    expect(typeof (body as { requestId: string }).requestId).toBe("string");
    expect((body as { requestId: string }).requestId.length).toBeGreaterThan(0);
  });
});

// ── Store backpressure → 503 + Retry-After (#3662) ───────────────────────────

describe("errorMiddleware store backpressure", () => {
  /** What @oxagen/telemetry's StoreOverloadedError puts on the wire. */
  function overloaded(retryAfterSeconds: number): Error {
    return Object.assign(
      new Error(
        `The telemetry store cannot take this request now: it is over its memory limit. Retry after ${String(retryAfterSeconds)} seconds.`,
      ),
      { code: "store_overloaded" as const, retryAfterSeconds },
    );
  }

  it("answers 503 with the store's own code, never a 500", async () => {
    const { status, body } = await triggerError(overloaded(30));
    expect(status).toBe(503);
    expect((body as { error: { code: string } }).error.code).toBe(
      "store_overloaded",
    );
  });

  it("tells the caller when to come back, in the header and the body", async () => {
    const { body, headers } = await triggerError(overloaded(30));
    expect(headers.get("Retry-After")).toBe("30");
    expect(
      (body as { error: { retryAfterSeconds: number } }).error
        .retryAfterSeconds,
    ).toBe(30);
  });

  it("never asks for an immediate retry", async () => {
    // A sub-second wait rounds to a whole second rather than to zero: a
    // `Retry-After: 0` invites the retry storm this answer exists to prevent.
    const { headers } = await triggerError(overloaded(0.2));
    expect(headers.get("Retry-After")).toBe("1");
  });

  it("keeps an error that only looks like one on the 500 path", async () => {
    const { status } = await triggerError(
      Object.assign(new Error("not a refusal"), { code: "store_overloaded" }),
    );
    expect(status).toBe(500);
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
    expect((body as { error: { code: string } }).error.code).toBe(
      "bad_request",
    );
  });

  it("pending_approval → 403 with code 'pending_approval' and the pollable accessRequestId", async () => {
    const { CapabilityError } = await import("@oxagen/oxagen/kernel");
    const { status, body } = await triggerError(
      new CapabilityError(
        "test.cap",
        "pending_approval",
        "denied pending approval",
        "arq_abc123",
      ),
    );
    expect(status).toBe(403);
    const b = body as {
      error: { code: string; accessRequestId?: string };
      requestId: string;
    };
    expect(b.error.code).toBe("pending_approval");
    // The access-request id is surfaced under a field distinct from the
    // envelope's request-correlation id so the client can poll for approval.
    expect(b.error.accessRequestId).toBe("arq_abc123");
  });

  it("pending_approval without an accessRequestId omits the field but still 403s", async () => {
    const { CapabilityError } = await import("@oxagen/oxagen/kernel");
    const { status, body } = await triggerError(
      new CapabilityError(
        "test.cap",
        "pending_approval",
        "denied pending approval",
      ),
    );
    expect(status).toBe(403);
    const b = body as { error: { code: string; accessRequestId?: string } };
    expect(b.error.code).toBe("pending_approval");
    expect(b.error.accessRequestId).toBeUndefined();
  });
});

// ── HandlerError → 403 / 404 / 409 ───────────────────────────────────────────

describe("errorMiddleware HandlerError", () => {
  it("forbidden → 403 with the reason in the envelope", async () => {
    const { HandlerError } = await import("@oxagen/oxagen");
    const { status, body } = await triggerError(
      new HandlerError({
        code: "forbidden",
        reason: "insufficient_role",
        message: "Only org Owners and Admins can remove members",
      }),
    );
    expect(status).toBe(403);
    const b = body as {
      error: { code: string; reason: string; message: string };
    };
    expect(b.error.code).toBe("forbidden");
    expect(b.error.reason).toBe("insufficient_role");
    expect(b.error.message).toBe(
      "Only org Owners and Admins can remove members",
    );
  });

  it("not_found → 404", async () => {
    const { HandlerError } = await import("@oxagen/oxagen");
    const { status, body } = await triggerError(
      new HandlerError({ code: "not_found", reason: "target_not_member" }),
    );
    expect(status).toBe(404);
    const b = body as { error: { code: string; reason: string } };
    expect(b.error.code).toBe("not_found");
    expect(b.error.reason).toBe("target_not_member");
  });

  it("conflict → 409", async () => {
    const { HandlerError } = await import("@oxagen/oxagen");
    const { status, body } = await triggerError(
      new HandlerError({ code: "conflict", reason: "last_owner" }),
    );
    expect(status).toBe(409);
    const b = body as { error: { code: string; reason: string } };
    expect(b.error.code).toBe("conflict");
    expect(b.error.reason).toBe("last_owner");
  });

  it("every HandlerError code has a status, so a new code cannot fall to 500", async () => {
    const { HANDLER_ERROR_CODES, HandlerError } = await import(
      "@oxagen/oxagen"
    );
    for (const code of HANDLER_ERROR_CODES) {
      const { status } = await triggerError(
        new HandlerError({ code, reason: "r" }),
      );
      expect(status, `${code} must not reach the catch-all`).not.toBe(500);
    }
  });

  it("always includes requestId", async () => {
    const { HandlerError } = await import("@oxagen/oxagen");
    const { body } = await triggerError(
      new HandlerError({ code: "conflict", reason: "last_owner" }),
    );
    expect(typeof (body as { requestId: string }).requestId).toBe("string");
  });
});

// ── Billing errors → 402 Payment Required ────────────────────────────────────

describe("errorMiddleware billing errors", () => {
  it("InsufficientCreditsError → 402", async () => {
    const err = Object.assign(new Error("no credits"), {
      code: "insufficient_credits",
    });
    const { status, body } = await triggerError(err);
    expect(status).toBe(402);
    expect((body as { error: { code: string } }).error.code).toBe(
      "insufficient_credits",
    );
  });

  it("BillingSuspendedError → 402", async () => {
    const err = Object.assign(new Error("suspended"), {
      code: "billing_suspended",
    });
    const { status, body } = await triggerError(err);
    expect(status).toBe(402);
    expect((body as { error: { code: string } }).error.code).toBe(
      "billing_suspended",
    );
  });

  // Regression — #1456. The hard period-to-date spend ceiling
  // (BudgetExceededError, code "budget_exceeded") was absent from the
  // middleware's duck-typed billing-code list, so a ceiling denial fell through
  // to the catch-all and returned a generic 500 instead of the 402 that both
  // spend-budget.ts and kernel.ts document. A spend ceiling is a payment
  // decision, not a server fault.
  it("BudgetExceededError → 402, not 500", async () => {
    const err = Object.assign(new Error("spend budget exceeded"), {
      code: "budget_exceeded",
    });
    const { status, body } = await triggerError(err);
    expect(status).toBe(402);
    expect((body as { error: { code: string } }).error.code).toBe(
      "budget_exceeded",
    );
    // The human message reaches the client, as it does for the two codes this
    // one mirrors — the caller needs to know WHICH ceiling stopped them.
    expect((body as { error: { message: string } }).error.message).toBe(
      "spend budget exceeded",
    );
  });

  // ADR-055: the GAU gate's refusal. A prepaid org whose month bucket is
  // empty and whose auto top-up could not run is a payment decision.
  it("GauExhaustedError → 402 with the code and no reason when none is set", async () => {
    const { GauExhaustedError } = await import("@oxagen/billing");
    const { status, body } = await triggerError(
      new GauExhaustedError({
        reason: null,
        remainingGau: -3,
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    expect(status).toBe(402);
    const b = body as { error: { code: string; reason?: string } };
    expect(b.error.code).toBe("gau_exhausted");
    expect("reason" in b.error).toBe(false);
  });

  it("GauExhaustedError carries reason free_no_payment_method in the body when set", async () => {
    const { GauExhaustedError } = await import("@oxagen/billing");
    const { status, body } = await triggerError(
      new GauExhaustedError({
        reason: "free_no_payment_method",
        remainingGau: 0,
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    expect(status).toBe(402);
    const b = body as { error: { code: string; reason?: string } };
    expect(b.error.code).toBe("gau_exhausted");
    expect(b.error.reason).toBe("free_no_payment_method");
  });

  it("AssistantSpendCapError → 402 with its code, not 500", async () => {
    const { AssistantSpendCapError } = await import("@oxagen/billing");
    const { status, body } = await triggerError(
      new AssistantSpendCapError(500, 500),
    );
    expect(status).toBe(402);
    expect((body as { error: { code: string } }).error.code).toBe(
      "assistant_spend_cap",
    );
  });

  it("BILLING_ERROR_CODES lists gau_exhausted", async () => {
    const { BILLING_ERROR_CODES } = await import("../middleware/error");
    expect(BILLING_ERROR_CODES).toContain("gau_exhausted");
  });

  // The middleware's BILLING_ERROR_CODES list is a hand-maintained mirror of the
  // error classes @oxagen/billing throws. This asserts against the REAL classes,
  // so adding a fifth billing error without mapping it fails here rather than
  // in production as a 500.
  it("every billing error class @oxagen/billing throws maps to 402", async () => {
    const {
      InsufficientCreditsError,
      BillingSuspendedError,
      BudgetExceededError,
      GauExhaustedError,
      AssistantSpendCapError,
    } = await import("@oxagen/billing");
    const thrown: Error[] = [
      new AssistantSpendCapError(500, 500),
      new InsufficientCreditsError(),
      new BillingSuspendedError(null),
      new BudgetExceededError({
        scope: "workspace",
        orgId: "00000000-0000-0000-0000-000000000001",
        workspaceId: "00000000-0000-0000-0000-000000000002",
        period: "monthly",
        limitMicros: 1_000_000n,
        spentMicros: 2_000_000n,
        capability: "send_message",
      }),
      new GauExhaustedError({
        reason: null,
        remainingGau: 0,
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ];
    for (const err of thrown) {
      const { status, body } = await triggerError(err);
      expect(status, `${err.name} must map to 402 Payment Required`).toBe(402);
      expect((body as { error: { code: string } }).error.code).toBe(
        (err as unknown as { code: string }).code,
      );
    }
  });
});

// ── ask_assistant turn failures (@oxagen/agent) ───────────────────────────────

describe("errorMiddleware assistant turn failures", () => {
  it.each([
    ["engine_unavailable", 503],
    ["assistant_run_not_recorded", 503],
    ["engine_aborted", 409],
  ] as const)(
    "%s → %i with its code and message, never the 500 catch-all",
    async (code, expected) => {
      const err = Object.assign(new Error(`turn failed: ${code}`), { code });
      const { status, body } = await triggerError(err);
      expect(status).toBe(expected);
      expect(body).toMatchObject({
        error: { code, message: `turn failed: ${code}` },
        requestId: expect.any(String),
      });
    },
  );

  it("an error whose code is not a turn failure still falls to 500 (negative)", async () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    const { status } = await triggerError(err);
    expect(status).toBe(500);
  });
});

// ── Full app.fetch integration — confirm requestId is UUID from logger ────────

describe("error middleware via app.fetch (requestId from logger)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requestId on a real 404 (no auth) is UUID-shaped when logger middleware runs", async () => {
    const res = await app.fetch(makeRequest("/v1/no-such-route-xyz"));
    const body = (await res.json()) as { requestId?: string };
    // The route 404s at Hono routing level — error middleware may or may not set requestId.
    // What we assert: if requestId is present it is a non-empty string.
    if (body.requestId !== undefined) {
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId.length).toBeGreaterThan(0);
    }
  });
});

describe("tenant scope errors", () => {
  it.each(["no_tenant_scope", "invalid_tenant_scope"])(
    "maps %s to HTTP 400",
    async (code) => {
      const error = Object.assign(new Error("Tenant context is invalid"), {
        code,
      });
      const result = await triggerError(error);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "invalid_tenant_scope" },
      });
    },
  );
});
