// context.test.ts — unit tests for MCP auth utilities.
//
// Tests cover:
//   - McpUnauthorizedError construction and reason field
//   - extractBearerToken: valid / invalid / missing / edge-case inputs
//   - resolveMcpContext: unauthenticated, API key path, session token path,
//     expired and invalid token error propagation
//
// resolveApiKey and resolveSession are vi.mock()'d so no network / DB hits occur.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth resolvers before importing context.ts, which references them.
vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
}));

import { resolveApiKey, resolveSession } from "@oxagen/auth";
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
      },
    });
    expect(resolveApiKey).toHaveBeenCalledWith("oxk_mysecret");
  });

  it("returns invalid_token when resolveApiKey reports a non-expired failure", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "not_found" });

    const result = await resolveMcpContext("Bearer oxk_bad", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("returns expired_token when resolveApiKey reports kind=expired", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "expired" });

    const result = await resolveMcpContext("Bearer oxk_old", requestId);
    expect(result).toEqual({ ok: false, reason: "expired_token" });
  });

  it("resolves a session token (no underscore) via resolveSession", async () => {
    vi.mocked(resolveSession).mockResolvedValue({ userId: "user-abc" });

    const result = await resolveMcpContext("Bearer sessiontoken", requestId);
    expect(result).toEqual({
      ok: true,
      ctx: {
        orgId: "",
        workspaceId: "",
        userId: "user-abc",
        apiKeyId: null,
        requestId,
        surface: "mcp",
        messageId: null,
      },
    });
    expect(resolveSession).toHaveBeenCalledWith("sessiontoken");
  });

  it("returns invalid_token when resolveSession returns null (unknown session)", async () => {
    vi.mocked(resolveSession).mockResolvedValue(null);

    const result = await resolveMcpContext("Bearer badsession", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });
});
