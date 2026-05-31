/**
 * Unit tests for the MCP auth context resolver.
 *
 * Tests the authn-failure path (missing/invalid/expired token → not ok),
 * the valid API-key path → real CapabilityContext, and the valid session
 * path → real CapabilityContext. The resolver seam (@oxagen/auth) is
 * mocked at the module level — no DB connection needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// vi.hoisted runs before module resolution, so these refs are safe to use
// inside vi.mock factories (which are also hoisted).
const { mockResolveApiKey, mockResolveSession } = vi.hoisted(() => ({
  mockResolveApiKey: vi.fn(),
  mockResolveSession: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────
vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mockResolveApiKey,
  resolveSession: mockResolveSession,
}));

// ── imports after mocks ───────────────────────────────────────────────────────
import { extractBearerToken, resolveMcpContext } from "./context.js";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── extractBearerToken ────────────────────────────────────────────────────────

describe("extractBearerToken", () => {
  it("returns null when header is undefined", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null when header is empty", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null when header does not start with Bearer", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("returns null when Bearer is present but token is empty", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
  });

  it("returns null when Bearer has only whitespace after it", () => {
    expect(extractBearerToken("Bearer   ")).toBeNull();
  });

  it("returns token for a valid Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the 'bearer' prefix", () => {
    expect(extractBearerToken("BEARER mytoken")).toBe("mytoken");
    expect(extractBearerToken("bearer mytoken")).toBe("mytoken");
  });

  it("trims leading whitespace before Bearer", () => {
    expect(extractBearerToken("  Bearer tok_abc")).toBe("tok_abc");
  });
});

// ── resolveMcpContext — unauthenticated paths ─────────────────────────────────

describe("resolveMcpContext — unauthenticated paths", () => {
  it("returns unauthenticated when Authorization header is absent", async () => {
    const result = await resolveMcpContext(undefined);
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(mockResolveApiKey).not.toHaveBeenCalled();
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  it("returns unauthenticated when Authorization header is empty", async () => {
    const result = await resolveMcpContext("");
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("returns unauthenticated when header is not a Bearer token", async () => {
    const result = await resolveMcpContext("Basic dXNlcjpwYXNz");
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(mockResolveApiKey).not.toHaveBeenCalled();
    expect(mockResolveSession).not.toHaveBeenCalled();
  });
});

// ── resolveMcpContext — API key path ──────────────────────────────────────────

describe("resolveMcpContext — API key path", () => {
  it("returns invalid_token when the API key is malformed", async () => {
    mockResolveApiKey.mockResolvedValueOnce({ ok: false, kind: "malformed" });
    const result = await resolveMcpContext("Bearer pfx_mysecret");
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
    expect(mockResolveApiKey).toHaveBeenCalledWith("pfx_mysecret");
  });

  it("returns invalid_token when the API key is invalid", async () => {
    mockResolveApiKey.mockResolvedValueOnce({ ok: false, kind: "invalid" });
    const result = await resolveMcpContext("Bearer pfx_wrongsecret");
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("returns expired_token when the API key has expired", async () => {
    mockResolveApiKey.mockResolvedValueOnce({ ok: false, kind: "expired" });
    const result = await resolveMcpContext("Bearer pfx_expiredsecret");
    expect(result).toEqual({ ok: false, reason: "expired_token" });
  });

  it("returns a real CapabilityContext for a valid API key", async () => {
    mockResolveApiKey.mockResolvedValueOnce({
      ok: true,
      apiKeyId: "aky_abc",
      orgId: "org_xyz",
      workspaceId: "wrk_xyz",
    });

    const result = await resolveMcpContext("Bearer pfx_validsecret");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.ctx.orgId).toBe("org_xyz");
    expect(result.ctx.workspaceId).toBe("wrk_xyz");
    expect(result.ctx.userId).toBeNull();
    expect(result.ctx.apiKeyId).toBe("aky_abc");
    expect(result.ctx.surface).toBe("mcp");
    expect(result.ctx.messageId).toBeNull();
    expect(typeof result.ctx.requestId).toBe("string");
    expect(result.ctx.requestId.length).toBeGreaterThan(0);
  });

  it("does not route API-key tokens through session resolver", async () => {
    mockResolveApiKey.mockResolvedValueOnce({ ok: false, kind: "invalid" });
    await resolveMcpContext("Bearer pfx_something");
    expect(mockResolveSession).not.toHaveBeenCalled();
  });
});

// ── resolveMcpContext — session token path ────────────────────────────────────

describe("resolveMcpContext — session token path", () => {
  it("returns invalid_token when the session token is not found", async () => {
    mockResolveSession.mockResolvedValueOnce(null);
    // Session tokens have no underscore
    const result = await resolveMcpContext("Bearer sessiontokenwithnoundersc");
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
    expect(mockResolveSession).toHaveBeenCalledWith("sessiontokenwithnoundersc");
  });

  it("returns a real CapabilityContext for a valid session token", async () => {
    mockResolveSession.mockResolvedValueOnce({ userId: "usr_abc" });
    const result = await resolveMcpContext("Bearer sessiontokenwithnoundersc");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.ctx.userId).toBe("usr_abc");
    expect(result.ctx.apiKeyId).toBeNull();
    expect(result.ctx.surface).toBe("mcp");
    expect(result.ctx.messageId).toBeNull();
    expect(typeof result.ctx.requestId).toBe("string");
  });

  it("does not route session tokens through apiKey resolver", async () => {
    mockResolveSession.mockResolvedValueOnce({ userId: "usr_abc" });
    await resolveMcpContext("Bearer sessiontokenwithnoundersc");
    expect(mockResolveApiKey).not.toHaveBeenCalled();
  });
});
