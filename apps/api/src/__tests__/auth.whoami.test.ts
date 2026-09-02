/**
 * Tests for GET /v1/auth/whoami (src/routes/v1/auth.whoami.ts), driven through
 * app.fetch so the full authMiddleware → route chain is exercised.
 *
 * This route is the CLI's `oxagen login` validation probe. Its whole reason to
 * exist is that it works for an API-key (machine) actor — `userId: null` — which
 * the user.preferences.read / org.list / workspace.list handlers reject with a
 * 500. So the load-bearing assertion here is: a valid API key → 200 (NOT 500),
 * echoing the pre-bound org/workspace scope.
 *
 * Covers:
 * - valid API key → 200, echoes apiKeyId + orgId + workspaceId, userId null
 * - valid session → 200, echoes userId, apiKeyId/org/workspace null
 * - missing credentials → 401 (authMiddleware, before the route)
 * - invalid key → 401
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted keeps the mock references stable across dynamic imports.
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
  makeApiKeyInvalid,
  makeSessionValid,
} from "./_helpers";

const WHOAMI_PATH = "/v1/auth/whoami";

interface WhoamiBody {
  authenticated: boolean;
  userId: string | null;
  apiKeyId: string | null;
  orgId: string | null;
  workspaceId: string | null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /v1/auth/whoami — API key", () => {
  it("valid key → 200 (NOT 500) echoing the pre-bound scope", async () => {
    mocks.resolveApiKey.mockResolvedValue(
      makeApiKeyOk({
        apiKeyId: "key-123",
        orgId: "org-abc",
        workspaceId: "ws-xyz",
      }),
    );

    const res = await app.fetch(
      makeRequest(WHOAMI_PATH, {
        method: "GET",
        headers: { authorization: bearerHeader("ox_validkeyvalue") },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiBody;
    expect(body).toEqual({
      authenticated: true,
      userId: null,
      apiKeyId: "key-123",
      orgId: "org-abc",
      workspaceId: "ws-xyz",
    });
    // invoke must NOT be touched — whoami is pure transport, no capability.
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid key → 401 (authMiddleware rejects before the route)", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyInvalid());

    const res = await app.fetch(
      makeRequest(WHOAMI_PATH, {
        method: "GET",
        headers: { authorization: bearerHeader("ox_badkey") },
      }),
    );

    expect(res.status).toBe(401);
  });
});

describe("GET /v1/auth/whoami — session", () => {
  it("valid session → 200 echoing userId, scope null", async () => {
    mocks.parseSessionCookie.mockReturnValue("valid-token");
    mocks.resolveSession.mockResolvedValue(makeSessionValid("user-789"));

    const res = await app.fetch(
      makeRequest(WHOAMI_PATH, {
        method: "GET",
        headers: { cookie: "oxagen.session_token=valid-token.sig" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiBody;
    expect(body).toEqual({
      authenticated: true,
      userId: "user-789",
      apiKeyId: null,
      orgId: null,
      workspaceId: null,
    });
  });
});

describe("GET /v1/auth/whoami — no credentials", () => {
  it("missing credentials → 401", async () => {
    mocks.parseSessionCookie.mockReturnValue(null);

    const res = await app.fetch(makeRequest(WHOAMI_PATH, { method: "GET" }));

    expect(res.status).toBe(401);
  });
});
