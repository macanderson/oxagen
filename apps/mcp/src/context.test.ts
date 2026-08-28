// context.test.ts — unit tests for MCP auth utilities.
//
// Tests cover:
//   - McpUnauthorizedError construction and reason field
//   - extractBearerToken: valid / invalid / missing / edge-case inputs
//   - resolveMcpContext: unauthenticated, API key path, session token path
//     (rejected at the edge), expired and invalid token errors
//   - buildContext: header extraction, UUID fallback, clientIp from xff,
//     authorization-as-array, throws McpUnauthorizedError on auth failure
//   - firstHeader / extractClientIp behaviour exercised indirectly via buildContext
//
// resolveApiKey is vi.mock()'d so no network / DB hits occur. Session tokens
// are rejected at the MCP edge before any session resolver would be invoked.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth resolver before importing context.ts.
vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
}));

// Mock the security-event emitter — context.ts fires api_key.used on a
// successful resolveMcpContext. The emit is fire-and-forget; we assert it
// was called with the right shape, never that it blocks resolution.
// vi.hoisted lets the mock fn be referenced inside the hoisted vi.mock factory.
const { emitSecurityEventMock } = vi.hoisted(() => ({
  emitSecurityEventMock: vi.fn(),
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: emitSecurityEventMock,
}));

import { resolveApiKey } from "@oxagen/auth";
import {
  McpUnauthorizedError,
  extractBearerToken,
  resolveMcpContext,
  buildContext,
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
    expect(extractBearerToken("Bearer oxk_secretkeyvalue")).toBe(
      "oxk_secretkeyvalue",
    );
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

  it("emits an api_key.used security event on a successful API-key resolution", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });

    await resolveMcpContext("Bearer oxk_mysecret", requestId, "203.0.113.7");

    expect(emitSecurityEventMock).toHaveBeenCalledOnce();
    const [event] = emitSecurityEventMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(event.eventType).toBe("api_key.used");
    expect(event.outcome).toBe("success");
    expect(event.orgId).toBe("org-1");
    expect(event.workspaceId).toBe("ws-1");
    expect(event.actorUserId).toBeNull(); // machine auth — no user
    expect(event.ip).toBe("203.0.113.7"); // resolved client IP, not from a trusted source
    expect(event.requestId).toBe(requestId);
  });

  it("does NOT emit api_key.used when the API key fails to resolve", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "invalid" });

    await resolveMcpContext("Bearer oxk_bad", requestId);

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
  });

  it("does NOT emit api_key.used for a rejected session token (no underscore)", async () => {
    await resolveMcpContext("Bearer sessiontoken", requestId);

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
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

  // ── Session token path: rejected at edge with invalid_token ───────────────
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
    const result = await resolveMcpContext(
      "Bearer anothersessiontoken",
      requestId,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  // ── Empty orgId is always rejected ─────────────────────────────────────────
  //
  // resolveApiKey() should never return ok:true with an empty orgId (the
  // apiKeys.org_id column is populated at key creation), but if it ever did
  // — a data-integrity bug, a bad migration, a future refactor — an empty
  // orgId/workspaceId must be rejected at this edge exactly like the
  // session-token path is, rather than flowing through as an
  // apparently-successful resolution (emitting an api_key.used "success"
  // audit event and constructing a CapabilityContext with orgId:"").

  it("rejects a resolved API key with an empty orgId (never a valid scope)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });

    const result = await resolveMcpContext("Bearer oxk_emptyorg", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a resolved API key with an empty workspaceId (never a valid scope)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "",
      apiKeyId: "key-1",
    });

    const result = await resolveMcpContext("Bearer oxk_emptyws", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("does NOT emit api_key.used when the resolved orgId is empty", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });

    await resolveMcpContext("Bearer oxk_emptyorg", requestId);

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
  });

  it("buildContext throws McpUnauthorizedError with reason invalid_token for an empty-orgId resolution", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });

    await expect(
      buildContext({ authorization: "Bearer oxk_emptyorg" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer oxk_emptyorg" }),
    ).rejects.toMatchObject({ reason: "invalid_token" });
  });
});

// ── firstHeader (exercised via buildContext) ──────────────────────────────────
//
// firstHeader is not exported; its behaviour is verified indirectly through
// buildContext which calls it on hdrs["authorization"] and hdrs["x-request-id"].

describe("firstHeader (via buildContext header extraction)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a plain-string authorization header correctly", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({
      authorization: "Bearer oxk_plainstring",
      "x-request-id": "req-plain",
    });
    expect(ctx.requestId).toBe("req-plain");
    expect(resolveApiKey).toHaveBeenCalledWith("oxk_plainstring");
  });

  it("uses the first element when authorization is delivered as an array", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-2",
      workspaceId: "ws-2",
      apiKeyId: "key-2",
    });
    const ctx = await buildContext({
      // xmcp headers() repeats a header as an array; firstHeader() picks [0]
      authorization: ["Bearer oxk_fromarray", "Bearer oxk_ignored"],
      "x-request-id": "req-array",
    });
    expect(ctx.requestId).toBe("req-array");
    expect(resolveApiKey).toHaveBeenCalledWith("oxk_fromarray");
  });

  it("uses the first element when x-request-id is an array", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-request-id": ["req-first", "req-second"],
    });
    expect(ctx.requestId).toBe("req-first");
  });

  it("firstHeader(undefined) → undefined: missing x-request-id falls back to UUID", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({ authorization: "Bearer oxk_valid" });
    // requestId should be a UUID (no x-request-id supplied)
    expect(ctx.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ── extractClientIp (exercised via buildContext) ───────────────────────────────
//
// extractClientIp is not exported; its behaviour is verified indirectly through
// buildContext which calls it and stamps the result onto ctx.clientIp.

describe("extractClientIp (via buildContext clientIp extraction)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
  });

  it("extracts the first IP from a comma-separated x-forwarded-for", async () => {
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    });
    expect(ctx.clientIp).toBe("1.2.3.4");
  });

  it("trims whitespace from the extracted x-forwarded-for IP", async () => {
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-forwarded-for": " 1.2.3.4 , 5.6.7.8",
    });
    expect(ctx.clientIp).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-real-ip": "9.9.9.9",
    });
    expect(ctx.clientIp).toBe("9.9.9.9");
  });

  it("returns null when neither x-forwarded-for nor x-real-ip is present", async () => {
    const ctx = await buildContext({ authorization: "Bearer oxk_valid" });
    expect(ctx.clientIp).toBeNull();
  });

  it("handles x-forwarded-for as an array — uses first element", async () => {
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-forwarded-for": ["1.2.3.4, 5.6.7.8", "irrelevant"],
    });
    expect(ctx.clientIp).toBe("1.2.3.4");
  });
});

// ── buildContext ──────────────────────────────────────────────────────────────

describe("buildContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a context with surface 'mcp'", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-request-id": "req-123",
    });
    expect(ctx.surface).toBe("mcp");
  });

  it("stamps the x-request-id header onto ctx.requestId", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-request-id": "trace-abc-123",
    });
    expect(ctx.requestId).toBe("trace-abc-123");
  });

  it("generates a fresh UUID for requestId when x-request-id is absent", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({ authorization: "Bearer oxk_valid" });
    expect(ctx.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("stamps clientIp from x-forwarded-for onto the context", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({
      authorization: "Bearer oxk_valid",
      "x-forwarded-for": "203.0.113.5",
    });
    expect(ctx.clientIp).toBe("203.0.113.5");
  });

  it("throws McpUnauthorizedError with reason 'unauthenticated' when no auth header", async () => {
    await expect(buildContext({})).rejects.toThrow(McpUnauthorizedError);
    await expect(buildContext({})).rejects.toMatchObject({
      reason: "unauthenticated",
    });
  });

  it("throws McpUnauthorizedError with reason 'invalid_token' for a session token (no underscore)", async () => {
    await expect(
      buildContext({ authorization: "Bearer sessiontokennounder" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer sessiontokennounder" }),
    ).rejects.toMatchObject({ reason: "invalid_token" });
  });

  it("throws McpUnauthorizedError with reason 'expired_token' when resolveApiKey returns expired", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "expired" });
    await expect(
      buildContext({ authorization: "Bearer oxk_expired" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer oxk_expired" }),
    ).rejects.toMatchObject({ reason: "expired_token" });
  });

  it("throws McpUnauthorizedError with reason 'invalid_token' when resolveApiKey returns invalid", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "invalid" });
    await expect(
      buildContext({ authorization: "Bearer oxk_bad" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer oxk_bad" }),
    ).rejects.toMatchObject({ reason: "invalid_token" });
  });

  it("sets userId to null (MCP only uses API keys, not session users)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({ authorization: "Bearer oxk_valid" });
    expect(ctx.userId).toBeNull();
  });

  it("sets messageId to null (not applicable at auth time)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
    });
    const ctx = await buildContext({ authorization: "Bearer oxk_valid" });
    expect(ctx.messageId).toBeNull();
  });
});
