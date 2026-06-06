// context.test.ts — unit tests for MCP auth utilities.
//
// Tests cover:
//   - McpUnauthorizedError construction and reason field
//   - extractBearerToken: valid / invalid / missing / edge-case inputs
//   - resolveMcpContext: unauthenticated, API key path, session token path
//     (now rejected at edge — OXA-1515), expired and invalid token errors
//
// resolveApiKey is vi.mock()'d so no network / DB hits occur.
// resolveSession is intentionally no longer called by context.ts (session
// tokens are rejected at the MCP edge before any resolver is invoked).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth resolver before importing context.ts.
vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
}));

import { resolveApiKey } from "@oxagen/auth";
import {
  McpUnauthorizedError,
  extractBearerToken,
  resolveMcpContext,
} from "./context";

// ── McpUnauthorizedError ───────────────────────────────────────────────────────

describe("McpUnauthorizedError", () => {
  it("sets name to McpUnauthorizedError", () => {
    const err = new McpUnauthorizedError("unauthenticated");
    expect(err.name).toBe("McpUnauthorizedError");
  });

  it("exposes the reason on the instance", () => {
    const err = new McpUnauthorizedError("invalid_token");
    expect(err.reason).toBe("invalid_token");
  });

  it("sets a descriptive message containing the reason", () => {
    const err = new McpUnauthorizedError("expired_token");
    expect(err.message).toContain("expired_token");
  });

  it("is an instance of Error", () => {
    expect(new McpUnauthorizedError("unauthenticated")).toBeInstanceOf(Error);
  });
});

// ── extractBearerToken ─────────────────────────────────────────────────────────

describe("extractBearerToken", () => {
  it("returns the token from a well-formed Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive for the 'bearer' prefix", () => {
    expect(extractBearerToken("BEARER mytoken")).toBe("mytoken");
    expect(extractBearerToken("bearer mytoken")).toBe("mytoken");
    expect(extractBearerToken("Bearer mytoken")).toBe("mytoken");
  });

  it("handles leading/trailing whitespace around the full header value", () => {
    expect(extractBearerToken("  Bearer  mytoken  ")).toBe("mytoken");
  });

  it("returns null when the header is undefined", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null when the header is an empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null when the prefix is not 'bearer'", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Token abc123")).toBeNull();
  });

  it("returns null when the token after 'Bearer ' is empty", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Bearer   ")).toBeNull();
  });

  it("returns a token that contains underscores (API key format)", () => {
    expect(extractBearerToken("Bearer oxk_secretkeyvalue")).toBe("oxk_secretkeyvalue");
  });
});

// ── resolveMcpContext ─────────────────────────────────────────────────────────

describe("resolveMcpContext", () => {
  const requestId = "req-test-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unauthenticated when no Authorization header is provided", async () => {
    const result = await resolveMcpContext(undefined, requestId);
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("returns unauthenticated when Authorization header has no Bearer token", async () => {
    const result = await resolveMcpContext("Basic abc", requestId);
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("resolves an API key token (contains underscore) via resolveApiKey", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });

    const result = await resolveMcpContext("Bearer oxk_mysecret", requestId);
    expect(result).toEqual({
      ok: true,
      ctx: {
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: null,
        apiKeyId: "key-1",
        requestId,
        surface: "mcp",
        messageId: null,
        clientIp: null,
      },
    });
    expect(resolveApiKey).toHaveBeenCalledWith("oxk_mysecret");
  });

  it("returns invalid_token when resolveApiKey reports a non-expired failure", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "invalid" });

    const result = await resolveMcpContext("Bearer oxk_bad", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("returns expired_token when resolveApiKey reports kind=expired", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "expired" });

    const result = await resolveMcpContext("Bearer oxk_old", requestId);
    expect(result).toEqual({ ok: false, reason: "expired_token" });
  });

  // ── Session token path (OXA-1515): rejected at edge with invalid_token ────
  //
  // Session tokens (Better Auth opaque tokens, no underscore) carry no
  // org/workspace scope. Accepting them would produce orgId:"" which the
  // kernel's runInTenantScope rejects with TenantScopeError. We reject at
  // the edge instead so the caller receives a clean 401.

  it("rejects a session token (no underscore) with invalid_token — MCP requires API keys", async () => {
    const result = await resolveMcpContext("Bearer sessiontoken", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
    // resolveApiKey must NOT have been called (token has no underscore → not an API key).
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("rejects any token without an underscore as invalid_token regardless of content", async () => {
    const result = await resolveMcpContext("Bearer anothersessiontoken", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });
});
