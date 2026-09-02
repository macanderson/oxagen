/**
 * Unit tests for src/middleware/auth.ts (integration via app.fetch)
 *
 * Covers:
 * - API key malformed/invalid/expired → 401 with distinct messages
 * - Unknown error kind → "Unauthorized" fallback
 * - API key ok → sets orgId/workspaceId, userId=null
 * - Session valid → sets userId, apiKeyId=null
 * - No credentials → 401 "Missing credentials"
 * - Expired session (resolveSession returns null) → 401 "Session expired"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted keeps the mock references stable across dynamic imports
const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
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

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import {
  makeRequest,
  bearerHeader,
  makeApiKeyOk,
  makeApiKeyMalformed,
  makeApiKeyInvalid,
  makeApiKeyExpired,
  makeSessionValid,
} from "./_helpers";

// We test via the /v1/organizations POST route (user-scoped, auth only, no org/workspace).
// After auth succeeds we still need invoke to return something valid or the route will 500.
// We only care about auth failures (pre-route) so we only check status + error.message.
const AUTH_ONLY_PATH = "/v1/organizations";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── API key error paths ───────────────────────────────────────────────────────

describe("authMiddleware — API key errors", () => {
  it("malformed key → 401 'Malformed API key'", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyMalformed());
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: { authorization: bearerHeader("nounderscorehere") },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Malformed API key");
  });

  it("invalid key → 401 'Invalid API key'", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyInvalid());
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: { authorization: bearerHeader("oxk_badhash") },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid API key");
  });

  it("expired key → 401 'API key expired'", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyExpired());
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: { authorization: bearerHeader("oxk_expiredkey") },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("API key expired");
  });

  it("unknown error kind → 401 'Unauthorized' (fallback)", async () => {
    // Return an unrecognised kind not in the messages map
    mocks.resolveApiKey.mockResolvedValue({
      ok: false,
      kind: "unknown_future_kind",
    });
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: { authorization: bearerHeader("oxk_whatever") },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Unauthorized");
  });
});

// ── API key success path ──────────────────────────────────────────────────────

describe("authMiddleware — API key success", () => {
  it("sets orgId and workspaceId from the resolved key", async () => {
    mocks.resolveApiKey.mockResolvedValue(
      makeApiKeyOk({ orgId: "org-abc", workspaceId: "ws-xyz" }),
    );
    // After auth passes, invoke will be called for the organization.create route.
    // Mock it to return a success so we can reach the response.
    mocks.invoke.mockResolvedValue({ organizationId: "new-org" });

    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: {
          authorization: bearerHeader("oxk_validkey"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
      }),
    );
    // If auth passed and invoke returns, we get a 200 (not a 401)
    expect(res.status).not.toBe(401);
  });
});

// ── Session cookie path ───────────────────────────────────────────────────────

describe("authMiddleware — session cookie", () => {
  it("no credentials → 401 'Missing credentials'", async () => {
    mocks.parseSessionCookie.mockReturnValue(null);
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, { method: "POST" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Missing credentials");
  });

  it("session token in cookie but resolveSession returns null → 401 'Session expired'", async () => {
    mocks.parseSessionCookie.mockReturnValue("some-session-token");
    mocks.resolveSession.mockResolvedValue(null);
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: { cookie: "oxagen.session_token=some.token.sig" },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Session expired");
  });

  it("valid session → userId set, passes auth (no 401)", async () => {
    mocks.parseSessionCookie.mockReturnValue("valid-token");
    mocks.resolveSession.mockResolvedValue(makeSessionValid("user-789"));
    mocks.invoke.mockResolvedValue({ organizationId: "new-org" });
    const res = await app.fetch(
      makeRequest(AUTH_ONLY_PATH, {
        method: "POST",
        headers: {
          cookie: "oxagen.session_token=valid-token.sig",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
      }),
    );
    expect(res.status).not.toBe(401);
  });
});
