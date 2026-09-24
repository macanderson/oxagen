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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  __resetTrustedProxyHopsForTests,
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

  it("tells the caller to sign in through SSO for an sso_required refusal", () => {
    const err = new McpUnauthorizedError("sso_required");
    expect(err.message).toBe(
      "MCP request unauthorized: sso_required. This organization requires single sign-on. The person who created this key must sign in through SSO.",
    );
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
    expect(extractBearerToken("Bearer ox_secretkeyvalue")).toBe(
      "ox_secretkeyvalue",
    );
  });

  it("returns a realistic ox_ key verbatim (46-char base64url secret)", () => {
    // Real keys are minted as `ox_<base64url(32 bytes)>` — see
    // API_KEY_RAW_PREFIX in packages/auth/src/resolvers/api-key.ts. The
    // short `ox_...` fixtures elsewhere in this file exercise the same code
    // path; this one pins the actual on-the-wire shape.
    const raw = "ox_AbCdEfGhIjKl-_MnOpQrStUvWxYz0123456789AbCd";
    expect(extractBearerToken(`Bearer ${raw}`)).toBe(raw);
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
      userId: null,
    });

    const result = await resolveMcpContext("Bearer ox_mysecret", requestId);
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
        // Null, not absent: the exact shape is asserted here on purpose, so a
        // field added to the context has to be accounted for by whoever adds
        // it rather than appearing unnoticed in every MCP request.
        gatewaySessionUuid: null,
        gatewayChainGenesisHash: null,
      },
    });
    expect(resolveApiKey).toHaveBeenCalledWith("ox_mysecret");
  });

  it("emits an api_key.used security event on a successful API-key resolution", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });

    await resolveMcpContext("Bearer ox_mysecret", requestId, "203.0.113.7");

    expect(emitSecurityEventMock).toHaveBeenCalledOnce();
    const [event] = emitSecurityEventMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(event.eventType).toBe("api_key.used");
    expect(event.outcome).toBe("success");
    expect(event.orgId).toBe("org-1");
    expect(event.workspaceId).toBe("ws-1");
    // This key resolved to no person, so the access-log row records none.
    // A CLI session key resolves to one, and the row carries it — see
    // context.cli-session.test.ts.
    expect(event.actorUserId).toBeNull();
    expect(event.ip).toBe("203.0.113.7"); // resolved client IP, not from a trusted source
    expect(event.requestId).toBe(requestId);
  });

  it("does NOT emit api_key.used when the API key fails to resolve", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "invalid" });

    await resolveMcpContext("Bearer ox_bad", requestId);

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
  });

  it("does NOT emit api_key.used for a rejected session token (no underscore)", async () => {
    await resolveMcpContext("Bearer sessiontoken", requestId);

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
  });

  it("returns invalid_token when resolveApiKey reports a non-expired failure", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "invalid" });

    const result = await resolveMcpContext("Bearer ox_bad", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("returns expired_token when resolveApiKey reports kind=expired", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "expired" });

    const result = await resolveMcpContext("Bearer ox_old", requestId);
    expect(result).toEqual({ ok: false, reason: "expired_token" });
  });

  it("returns sso_required when the key's organization requires SSO (ADR-145)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: false,
      kind: "sso_required",
    });

    const result = await resolveMcpContext("Bearer ox_member", requestId);
    expect(result).toEqual({ ok: false, reason: "sso_required" });
    expect(emitSecurityEventMock).not.toHaveBeenCalled();
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
      userId: null,
    });

    const result = await resolveMcpContext("Bearer ox_emptyorg", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a resolved API key with an empty workspaceId (never a valid scope)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "",
      apiKeyId: "key-1",
      userId: null,
    });

    const result = await resolveMcpContext("Bearer ox_emptyws", requestId);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("does NOT emit api_key.used when the resolved orgId is empty", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });

    await resolveMcpContext("Bearer ox_emptyorg", requestId);

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
  });

  it("buildContext throws McpUnauthorizedError with reason invalid_token for an empty-orgId resolution", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });

    await expect(
      buildContext({ authorization: "Bearer ox_emptyorg" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer ox_emptyorg" }),
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
      userId: null,
    });
    const ctx = await buildContext({
      authorization: "Bearer ox_plainstring",
      "x-request-id": "req-plain",
    });
    expect(ctx.requestId).toBe("req-plain");
    expect(resolveApiKey).toHaveBeenCalledWith("ox_plainstring");
  });

  it("uses the first element when authorization is delivered as an array", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-2",
      workspaceId: "ws-2",
      apiKeyId: "key-2",
      userId: null,
    });
    const ctx = await buildContext({
      // xmcp headers() repeats a header as an array; firstHeader() picks [0]
      authorization: ["Bearer ox_fromarray", "Bearer ox_ignored"],
      "x-request-id": "req-array",
    });
    expect(ctx.requestId).toBe("req-array");
    expect(resolveApiKey).toHaveBeenCalledWith("ox_fromarray");
  });

  it("uses the first element when x-request-id is an array", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
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
      userId: null,
    });
    const ctx = await buildContext({ authorization: "Bearer ox_valid" });
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
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8");
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });
  });

  afterEach(() => {
    __resetTrustedProxyHopsForTests();
    vi.unstubAllEnvs();
  });

  it("prefers the address the edge wrote", async () => {
    // Believed only once the operator has turned the gate on, after the Caddy
    // config that SETS the header is deployed (ADR-083).
    vi.stubEnv("TRUST_EDGE_CLIENT_IP_HEADER", "true");
    __resetTrustedProxyHopsForTests();
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-oxagen-client-ip": "198.51.100.1",
      "x-forwarded-for": "203.0.113.9, 10.0.0.5",
    });
    expect(ctx.clientIp).toBe("198.51.100.1");
  });

  // The #3183 second P1. Caddy's config ships through the infra pipeline and
  // this code through the application one. Until the config lands, the old
  // Caddyfile has no rule for x-oxagen-client-ip and forwards a caller's copy
  // straight through, and ctx.clientIp is what the IAM ip_ranges condition
  // ALLOWS on.
  //
  // A test asserting only "the edge header is preferred when present" passes
  // against the implementation being flagged, so this one forges the header and
  // asserts the forged value does not come back.
  it("does not believe a forged edge header before the gate is turned on", async () => {
    const alone = await buildContext({
      authorization: "Bearer ox_valid",
      "x-oxagen-client-ip": "198.51.100.1",
    });
    expect(alone.clientIp).toBeNull();

    const withChain = await buildContext({
      authorization: "Bearer ox_valid",
      "x-oxagen-client-ip": "198.51.100.1",
      "x-forwarded-for": "203.0.113.9, 10.0.0.5",
    });
    expect(withChain.clientIp).toBe("203.0.113.9");
  });

  // #3183 P1. ctx.clientIp feeds the IAM ip_ranges condition, which ALLOWS on a
  // CIDR match. This took the leftmost x-forwarded-for entry, so an MCP client
  // could prefix an allowlisted address and satisfy an IP-scoped mandate.
  it("ignores a caller-supplied x-forwarded-for prefix", async () => {
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-forwarded-for": "203.0.113.9, 198.51.100.1, 10.0.0.5",
    });
    expect(ctx.clientIp).toBe("198.51.100.1");
  });

  it("never believes x-real-ip, which nothing in front of this process sets", async () => {
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-real-ip": "198.51.100.1",
    });
    expect(ctx.clientIp).toBeNull();
  });

  it("returns null when no trusted proxy named the caller", async () => {
    const ctx = await buildContext({ authorization: "Bearer ox_valid" });
    expect(ctx.clientIp).toBeNull();
  });

  it("handles x-forwarded-for as an array — uses the first element's chain", async () => {
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-forwarded-for": ["198.51.100.1, 10.0.0.5", "irrelevant"],
    });
    expect(ctx.clientIp).toBe("198.51.100.1");
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
      userId: null,
    });
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
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
      userId: null,
    });
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
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
      userId: null,
    });
    const ctx = await buildContext({ authorization: "Bearer ox_valid" });
    expect(ctx.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("stamps clientIp from x-forwarded-for onto the context", async () => {
    // Attribution is by proxy identity, so this block has to name one: without
    // TRUSTED_PROXY_CIDRS nothing in the header is vouched for and clientIp is
    // null, which is the honest answer rather than a stamping failure.
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8");
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-forwarded-for": "203.0.113.5, 10.0.0.5",
    });
    expect(ctx.clientIp).toBe("203.0.113.5");
    __resetTrustedProxyHopsForTests();
    vi.unstubAllEnvs();
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
      buildContext({ authorization: "Bearer ox_expired" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer ox_expired" }),
    ).rejects.toMatchObject({ reason: "expired_token" });
  });

  it("throws McpUnauthorizedError with reason 'invalid_token' when resolveApiKey returns invalid", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({ ok: false, kind: "invalid" });
    await expect(
      buildContext({ authorization: "Bearer ox_bad" }),
    ).rejects.toThrow(McpUnauthorizedError);
    await expect(
      buildContext({ authorization: "Bearer ox_bad" }),
    ).rejects.toMatchObject({ reason: "invalid_token" });
  });

  it("carries the resolver's principal — null for a key that acts for nobody", async () => {
    // Not "MCP has no users". MCP has no *session* users; a bearer key may
    // still act for a person, and `resolveApiKey` is the one thing that
    // decides which. See context.cli-session.test.ts for the key that does.
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });
    const ctx = await buildContext({ authorization: "Bearer ox_valid" });
    expect(ctx.userId).toBeNull();
  });

  it("sets messageId to null (not applicable at auth time)", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });
    const ctx = await buildContext({ authorization: "Bearer ox_valid" });
    expect(ctx.messageId).toBeNull();
  });
});

// ── INV-31: no surface builds a platform-operator binding ─────────────────────
//
// `set_org_billing_terms` is reachable only from a `CapabilityContext` carrying
// a binding minted by `createPlatformOperatorContext` (packages/oxagen). The
// kernel refuses any other value on that field; the second half of the
// invariant is that no surface's context builder puts one there at all — not
// even `undefined`, which a later spread could overwrite unnoticed
// (apps/app/ARCHITECTURE.md §4, INV-31).

describe("buildContext and the platform-operator binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds no platformOperator key at all", async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });

    const ctx = await buildContext({ authorization: "Bearer ox_valid" });

    expect("platformOperator" in ctx).toBe(false);
  });
});

// ── the Tacho gateway chain header (#3221) ───────────────────────────────────
//
// `x-tacho-gateway-session` names the daemon chain a local MCP gateway is
// serving. It is the one header besides `x-request-id` this surface reads, and
// unlike that one it ends up in a durable evidence row — so what it is allowed
// to be is part of the contract, not an implementation detail.
describe("the gateway chain header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveApiKey).mockResolvedValue({
      ok: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      apiKeyId: "key-1",
      userId: null,
    });
  });

  it("carries a chain id through to the context", async () => {
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-tacho-gateway-session": "tachod-8f2c1e40-0000-4000-8000-000000000001",
    });
    expect(ctx.gatewaySessionUuid).toBe(
      "tachod-8f2c1e40-0000-4000-8000-000000000001",
    );
  });

  it("is null when absent, which is every non-gateway request", async () => {
    const ctx = await buildContext({ authorization: "Bearer ox_valid" });
    expect(ctx.gatewaySessionUuid).toBeNull();
  });

  it("refuses a value that is not shaped like a chain id", async () => {
    // Not because a malformed value is dangerous on its own — it decides
    // nothing, and `machineKeyDenial` reads it only for a gateway key — but
    // because it is written to a row that an operator later reads as evidence.
    // Rejecting here keeps the evidence table free of anything that cannot be
    // a chain, rather than trusting the credential to imply the value is sane.
    for (const bad of [
      "",
      "   ",
      "chain with spaces",
      "chain'; drop table--",
      "x".repeat(129),
    ]) {
      const ctx = await buildContext({
        authorization: "Bearer ox_valid",
        "x-tacho-gateway-session": bad,
      });
      expect(ctx.gatewaySessionUuid).toBeNull();
    }
  });

  it("takes the first value when the header repeats", async () => {
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-tacho-gateway-session": ["tachod-first", "tachod-second"],
    });
    expect(ctx.gatewaySessionUuid).toBe("tachod-first");
  });

  it("carries the chain's genesis hash, in the shape every chain hash has", async () => {
    // The hash is what makes the chain id above evidence rather than a name,
    // and it is written to a durable evidence row and compared against one —
    // so it is accepted only in the shape a Tacho chain hash has.
    const good = `sha256:${"a".repeat(64)}`;
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-tacho-gateway-genesis": good,
    });
    expect(ctx.gatewayChainGenesisHash).toBe(good);

    for (const bad of [
      "",
      "deadbeef",
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      `sha512:${"a".repeat(64)}`,
    ]) {
      const rejected = await buildContext({
        authorization: "Bearer ox_valid",
        "x-tacho-gateway-genesis": bad,
      });
      expect(rejected.gatewayChainGenesisHash).toBeNull();
    }
  });

  it("never lets the header touch tenant identity", async () => {
    // The standing invariant of this module. A header that can be set by
    // anything reaching the endpoint must not select an org, a workspace or a
    // key, and this one is read into a field beside them.
    const ctx = await buildContext({
      authorization: "Bearer ox_valid",
      "x-tacho-gateway-session": "tachod-abc",
      "x-oxagen-org-id": "org-attacker",
    });
    expect(ctx.orgId).toBe("org-1");
    expect(ctx.workspaceId).toBe("ws-1");
    expect(ctx.apiKeyId).toBe("key-1");
  });
});
