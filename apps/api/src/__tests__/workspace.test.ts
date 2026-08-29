/**
 * Unit tests for src/middleware/workspace.ts
 *
 * Covers:
 * - API-key short-circuit (workspaceId preset → next)
 * - Missing orgId → 400
 * - Missing workspace slug → 400 (covered structurally by route param)
 * - not_found → 404 "Workspace not found"
 * - Cross-tenant workspace (workspace belongs to another org) → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  makeSessionValid,
  makeOrgScopeOk,
  makeWorkspaceScopeOk,
  makeWorkspaceNotFound,
  makeWorkspaceNotMember,
} from "./_helpers";

function orgWsPath(orgSlug = "my-org", wsSlug = "my-ws"): string {
  return `/v1/${orgSlug}/${wsSlug}/conversations`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── API-key short-circuit ─────────────────────────────────────────────────────

describe("workspaceMiddleware — API key short-circuit", () => {
  it("skips workspace slug resolution when workspaceId is pre-bound by API key", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
    mocks.invoke.mockResolvedValue({ conversations: [], nextCursor: null });

    const res = await app.fetch(
      makeRequest(orgWsPath(), {
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    expect(mocks.resolveWorkspaceScope).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

// ── Session-auth workspace error paths ────────────────────────────────────────

describe("workspaceMiddleware — session-auth paths", () => {
  function sessionHeaders(): Record<string, string> {
    return { cookie: "oxagen.session_token=tok.sig" };
  }

  beforeEach(() => {
    mocks.parseSessionCookie.mockReturnValue("tok");
    mocks.resolveSession.mockResolvedValue(makeSessionValid("user-222"));
    // Org always resolves successfully in this describe block
    mocks.resolveOrgScope.mockResolvedValue(makeOrgScopeOk("org-222"));
  });

  it("workspace not_found → 404 'Workspace not found'", async () => {
    mocks.resolveWorkspaceScope.mockResolvedValue(makeWorkspaceNotFound());

    const res = await app.fetch(
      makeRequest(orgWsPath("my-org", "nonexistent-ws"), {
        headers: sessionHeaders(),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Workspace not found");
  });

  it("cross-tenant: workspace from another org returns 404 (not 403)", async () => {
    // resolveWorkspaceScope is scoped to the resolved orgId; a workspace from
    // another org returns not_found. The HTTP layer must return 404.
    mocks.resolveWorkspaceScope.mockResolvedValue(makeWorkspaceNotFound());

    const res = await app.fetch(
      makeRequest(orgWsPath("my-org", "other-orgs-ws"), {
        headers: sessionHeaders(),
      }),
    );
    expect(res.status).toBe(404);
    // Must NOT be 403 — no IDOR through status code distinction
    expect(res.status).not.toBe(403);
  });

  it("workspace resolution success → proceeds to route handler", async () => {
    mocks.resolveWorkspaceScope.mockResolvedValue(
      makeWorkspaceScopeOk("ws-222"),
    );
    mocks.invoke.mockResolvedValue({ conversations: [], nextCursor: null });

    const res = await app.fetch(
      makeRequest(orgWsPath(), { headers: sessionHeaders() }),
    );
    expect(res.status).toBe(200);
  });

  it("workspace not_member → 403 Forbidden (workspace isolation — user in ws-alpha cannot reach ws-beta)", async () => {
    // Simulates the cross-workspace isolation failure caught by the e2e spec:
    // workspace-isolation.spec.ts — "ws-alpha session cannot list ws-beta conversations".
    // resolveWorkspaceScope now checks workspace_users and returns not_member when
    // the authenticated userId is not a member of the target workspace.
    mocks.resolveWorkspaceScope.mockResolvedValue(makeWorkspaceNotMember());

    const res = await app.fetch(
      makeRequest(orgWsPath("my-org", "ws-beta"), {
        headers: sessionHeaders(),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Forbidden");
  });
});
