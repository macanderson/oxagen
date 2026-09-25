/**
 * Unit tests for the transport-agnostic identity resolvers.
 *
 * The DB seam is mocked at the module level using vi.mock so that no real
 * database connection is needed. Each test drives the mock to return a
 * specific row shape and asserts the resolver output.
 *
 * Cross-tenant isolation is verified explicitly: a user who is a member of
 * org A must not resolve org B's scope even when org B exists in the DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// DB mock — hoisted so imports in the resolvers see the mock immediately.
// ---------------------------------------------------------------------------

const mockQuery = {
  sessions: { findFirst: vi.fn() },
  apiKeys: { findFirst: vi.fn() },
  organizations: { findFirst: vi.fn() },
  orgUsers: { findFirst: vi.fn() },
  workspaces: { findFirst: vi.fn() },
  workspaceUsers: { findFirst: vi.fn() },
  orgSecurityPolicy: { findFirst: vi.fn() },
  tachoHosts: { findFirst: vi.fn() },
};

// Mock for Drizzle query builder used in resolveOrgScope (org.ts)
let selectMockResult: unknown[] = [];

const createMockBuilder = () => {
  const self = {
    from: vi.fn(function () {
      return self;
    }),
    innerJoin: vi.fn(function () {
      return self;
    }),
    where: vi.fn(function () {
      return self;
    }),
    limit: vi.fn(async function () {
      return selectMockResult;
    }),
  };
  return self;
};

const fakeTx = {
  query: mockQuery,
  select: vi.fn(() => createMockBuilder()),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeTx,
    withSystemDb: async (fn: (tx: typeof fakeTx) => Promise<unknown>) =>
      fn(fakeTx),
  };
});

// Whether the org's plan includes SSO (ADR-145). Only read once an org
// requires SSO, so the default of "entitled" never matters elsewhere.
const mockOrgHasSso = vi.fn(async (_orgId: string) => true);
vi.mock("../sso/entitlement", () => ({
  orgHasSso: (orgId: string) => mockOrgHasSso(orgId),
}));

// Import resolvers after the mock is registered.
import {
  resolveSession,
  parseSessionCookie,
  stripCookieSignature,
  SESSION_COOKIE_NAME,
  resolveApiKey,
  apiKeyPrefix,
  API_KEY_PREFIX_LENGTH,
  resolveOrgScope,
  resolveWorkspaceScope,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function futureDate(offsetMs = 60_000): Date {
  return new Date(Date.now() + offsetMs);
}

function pastDate(offsetMs = 60_000): Date {
  return new Date(Date.now() - offsetMs);
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// SESSION_COOKIE_NAME
// ---------------------------------------------------------------------------

describe("SESSION_COOKIE_NAME", () => {
  it("is oxagen.session_token (matches cookiePrefix in auth.ts)", () => {
    expect(SESSION_COOKIE_NAME).toBe("oxagen.session_token");
  });
});

// ---------------------------------------------------------------------------
// stripCookieSignature
// ---------------------------------------------------------------------------

describe("stripCookieSignature", () => {
  it("strips a 44-char base64 HMAC suffix from a signed value", () => {
    // Better Auth signs as `${token}.${base64(HMAC-SHA256(secret, token))}`
    // A base64 SHA-256 HMAC is exactly 44 characters (32 bytes * 4/3, padded).
    const token = "abc123rawtoken";
    const sig44 = "A".repeat(43) + "="; // 44-char base64-shaped suffix
    expect(stripCookieSignature(`${token}.${sig44}`)).toBe(token);
  });

  it("returns the value unchanged when there is no dot", () => {
    expect(stripCookieSignature("nodot")).toBe("nodot");
  });

  it("returns the full value when suffix length is not 44", () => {
    // Non-HMAC dot-containing token (e.g. JWT components) must not be
    // truncated — the unexpected suffix length is a signal to leave it alone.
    const nonHmac = "header.payload.signature";
    expect(stripCookieSignature(nonHmac)).toBe(nonHmac);
  });

  it("handles a token that itself contains dots", () => {
    // Token may contain dots — only the LAST segment matching 44 chars is stripped.
    const token = "tok.with.dots.inside";
    const sig44 = "B".repeat(43) + "=";
    expect(stripCookieSignature(`${token}.${sig44}`)).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// parseSessionCookie
// ---------------------------------------------------------------------------

// Construct a realistic signed cookie value the way Better Auth / E2E helpers do:
// `${rawToken}.${base64HmacSignature}`
function makeSignedCookieValue(rawToken: string): string {
  // Use a predictable 44-char base64 signature for test purposes.
  const fakeSig = "X".repeat(43) + "=";
  return `${rawToken}.${fakeSig}`;
}

describe("parseSessionCookie", () => {
  it("returns null when header is undefined", () => {
    expect(parseSessionCookie(undefined)).toBeNull();
  });

  it("returns null when the cookie is absent", () => {
    expect(parseSessionCookie("foo=bar; baz=qux")).toBeNull();
  });

  it("returns the raw (unsigned) token when present with HMAC suffix", () => {
    const rawToken = "abc123";
    const signed = makeSignedCookieValue(rawToken);
    const header = `other=x; oxagen.session_token=${encodeURIComponent(signed)}; more=y`;
    expect(parseSessionCookie(header)).toBe(rawToken);
  });

  it("returns null for an empty token value", () => {
    const header = "oxagen.session_token=";
    expect(parseSessionCookie(header)).toBeNull();
  });

  it("handles a cookie header with no spaces around semicolons", () => {
    const rawToken = "tok_xyz";
    const signed = makeSignedCookieValue(rawToken);
    const header = `a=1;oxagen.session_token=${signed};b=2`;
    expect(parseSessionCookie(header)).toBe(rawToken);
  });

  it("does NOT match Better Auth's default 'better-auth.session_token' cookie name", () => {
    const rawToken = "abc123";
    const signed = makeSignedCookieValue(rawToken);
    const header = `better-auth.session_token=${signed}`;
    expect(parseSessionCookie(header)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Production secure-cookie prefix.
  //
  // In production Better Auth sets `advanced.useSecureCookies = true`, which
  // prepends the `__Secure-` prefix to EVERY cookie name — so the real session
  // cookie on https is `__Secure-oxagen.session_token`, NOT the bare name. The
  // parser must accept the prefixed name or every client→API call 401s with
  // "Missing credentials" in production while passing in dev/E2E (http, no
  // prefix). This is the prod-only failure behind the GitHub-connection and
  // conversation-files-drawer 401s.
  // ---------------------------------------------------------------------------
  it("matches the production __Secure- prefixed cookie name", () => {
    const rawToken = "prod_secure_tok";
    const signed = makeSignedCookieValue(rawToken);
    const header = `__Secure-oxagen.session_token=${encodeURIComponent(signed)}`;
    expect(parseSessionCookie(header)).toBe(rawToken);
  });

  it("matches the __Host- prefixed cookie name", () => {
    const rawToken = "host_tok";
    const signed = makeSignedCookieValue(rawToken);
    const header = `__Host-oxagen.session_token=${signed}`;
    expect(parseSessionCookie(header)).toBe(rawToken);
  });

  it("finds the __Secure- cookie among other cookies in the header", () => {
    const rawToken = "tok_amid_others";
    const signed = makeSignedCookieValue(rawToken);
    const header = `theme=dark; __Secure-oxagen.session_token=${signed}; other=1`;
    expect(parseSessionCookie(header)).toBe(rawToken);
  });

  it("does NOT match a __Secure- prefix on the OLD default cookie name", () => {
    // Defense in depth: prefixing the wrong base name must still miss.
    const rawToken = "abc123";
    const signed = makeSignedCookieValue(rawToken);
    const header = `__Secure-better-auth.session_token=${signed}`;
    expect(parseSessionCookie(header)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSession
// ---------------------------------------------------------------------------

describe("resolveSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for an empty token", async () => {
    const result = await resolveSession("");
    expect(result).toBeNull();
    expect(mockQuery.sessions.findFirst).not.toHaveBeenCalled();
  });

  it("returns null when no session row is found", async () => {
    mockQuery.sessions.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveSession("unknown-token");
    expect(result).toBeNull();
  });

  it("returns null when the session is expired", async () => {
    mockQuery.sessions.findFirst.mockResolvedValueOnce({
      userId: "usr_a",
      expiresAt: pastDate(),
    });
    const result = await resolveSession("expired-token");
    expect(result).toBeNull();
  });

  it("returns userId when the session is valid", async () => {
    mockQuery.sessions.findFirst.mockResolvedValueOnce({
      userId: "usr_abc",
      expiresAt: futureDate(),
    });
    const result = await resolveSession("valid-token");
    expect(result).toEqual({ userId: "usr_abc" });
  });

  it("treats a session expiring exactly now as expired", async () => {
    // expiresAt set to Date.now() — after getTime() < Date.now() the check
    // may flake by ~1 ms but is functionally correct; we use pastDate(1) to
    // be deterministic.
    mockQuery.sessions.findFirst.mockResolvedValueOnce({
      userId: "usr_abc",
      expiresAt: pastDate(1),
    });
    const result = await resolveSession("edge-token");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveApiKey
//
// Real keys are `ox_<base64url(32 bytes)>` (46 chars), minted by
// generateApiKey() in @oxagen/handlers. The indexed lookup prefix is a FIXED
// 12-char leading window — `rawKey.slice(0, API_KEY_PREFIX_LENGTH)` — NOT a
// split on the first "_". These tests use realistic ox_ keys and include an
// explicit regression guard for the prod bug where resolveApiKey split on "_"
// → extracted "ox" → never matched the stored 12-char prefix, so every
// app-generated key was rejected on the API/MCP/CLI bearer-auth paths.
// ---------------------------------------------------------------------------

// Mirror generateApiKey()'s output shape with a deterministic secret so the
// 12-char prefix window is stable: "ox_" + 44 chars. The base64url alphabet
// includes "-" and "_", so the secret intentionally contains a "_" to prove the
// resolver does NOT split on it.
const RAW_KEY = "ox_AbCdEfGhIjKl-_MnOpQrStUvWxYz0123456789AbCd";
const RAW_KEY_PREFIX = "ox_AbCdEfGhI"; // RAW_KEY.slice(0, 12) — 12 chars

describe("resolveApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every key names a workspace, and the resolver reads that workspace to
    // see whether it is archived (ADR-105). The default here is the ordinary
    // case — an active workspace — so each test below states only what it is
    // about. The archived and missing cases are driven explicitly.
    mockQuery.workspaces.findFirst.mockResolvedValue({
      id: "wrk_xyz",
      archivedAt: null,
    });
  });

  it("returns malformed when the key does not start with the ox_ marker", async () => {
    const result = await resolveApiKey("noseparatorhere");
    expect(result).toEqual({ ok: false, kind: "malformed" });
    expect(mockQuery.apiKeys.findFirst).not.toHaveBeenCalled();
  });

  it("returns malformed when the key is only the prefix with no secret", async () => {
    // Length <= the 12-char prefix window — there is no secret to hash.
    const result = await resolveApiKey("ox_abcdef");
    expect(result).toEqual({ ok: false, kind: "malformed" });
    expect(mockQuery.apiKeys.findFirst).not.toHaveBeenCalled();
  });

  it("returns invalid when no row matches the prefix", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("returns invalid when the hash does not match", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_1",
      keyHash: sha256hex("ox_AbCdEfGhIj_DIFFERENT_KEY_ENTIRELY_00000000"),
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: null,
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("returns invalid (not a crash) when the stored keyHash has an unexpected length", async () => {
    // A corrupted/truncated keyHash yields a buffer whose length differs from
    // the 32-byte SHA-256 digest. timingSafeEqual would throw RangeError on
    // mismatched lengths; the length guard must return a clean auth failure.
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_corrupt",
      keyHash: "deadbeef", // 4 bytes — not a full SHA-256 digest
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: null,
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("returns invalid (not a crash) when the stored keyHash contains non-hex characters", async () => {
    // Buffer.from(nonHex, 'hex') silently produces a short/zero-length buffer.
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_garbage",
      keyHash: "not-a-valid-hex-string",
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: null,
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("returns expired when the key has passed its expiry", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_2",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: pastDate(),
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "expired" });
  });

  it("returns ok with scope for a valid non-expiring key", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_3",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({
      ok: true,
      apiKeyId: "aky_3",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      userId: null,
    });
  });

  it("returns ok for a valid key that has not yet expired", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_4",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: futureDate(3_600_000),
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({
      ok: true,
      apiKeyId: "aky_4",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      userId: null,
    });
  });

  // -------------------------------------------------------------------------
  // A revoked Tacho host's key (#3944, S-04). Revoking a host deletes its
  // keys, so the live lookup finds nothing. The host must hear that it was
  // revoked, not that its key is unknown, or it retries for ever.
  // -------------------------------------------------------------------------
  const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";
  const retiredHostKey = (over: Record<string, unknown> = {}) => ({
    id: "aky_host",
    keyHash: sha256hex(RAW_KEY),
    orgId: "org_abc",
    scope: { purpose: "tacho_host_v1", host_enrollment_id: ENROLLMENT },
    ...over,
  });

  it("answers host_revoked for a revoked host's retired key", async () => {
    mockQuery.apiKeys.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(retiredHostKey());
    mockQuery.tachoHosts.findFirst.mockResolvedValueOnce({ id: "tch_row" });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "host_revoked" });
    expect(mockQuery.tachoHosts.findFirst).toHaveBeenCalledTimes(1);
    // The workspace and membership reads belong to a live key only.
    expect(mockQuery.workspaces.findFirst).not.toHaveBeenCalled();
  });

  it("answers host_revoked for the gateway key the same enrollment minted", async () => {
    mockQuery.apiKeys.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(
        retiredHostKey({
          id: "aky_gateway",
          scope: {
            purpose: "tacho_gateway_v1",
            host_enrollment_id: ENROLLMENT,
          },
        }),
      );
    mockQuery.tachoHosts.findFirst.mockResolvedValueOnce({ id: "tch_row" });
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: false,
      kind: "host_revoked",
    });
  });

  it("stays invalid when the retired key's hash does not match (negative)", async () => {
    mockQuery.apiKeys.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(
        retiredHostKey({ keyHash: sha256hex(`${RAW_KEY}_other`) }),
      );
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(mockQuery.tachoHosts.findFirst).not.toHaveBeenCalled();
  });

  it("stays invalid for a deleted key no revoked host names (negative)", async () => {
    mockQuery.apiKeys.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(retiredHostKey({ id: "aky_plain", scope: {} }));
    mockQuery.tachoHosts.findFirst.mockResolvedValueOnce(undefined);
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  // -------------------------------------------------------------------------
  // The scope purpose decides who the bearer is.
  // -------------------------------------------------------------------------
  const cliKeyRow = (createdById: string | null = "user_approver") => ({
    id: "aky_cli",
    keyHash: sha256hex(RAW_KEY),
    orgId: "org_abc",
    workspaceId: "wrk_xyz",
    expiresAt: null,
    scope: { purpose: "cli_session_v1" },
    createdById,
  });

  it("a CLI session key authenticates as the user who approved the authorize flow", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(cliKeyRow());
    mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ id: "ou_1" });
    mockQuery.workspaceUsers.findFirst.mockResolvedValueOnce({ id: "wsu_1" });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({
      ok: true,
      apiKeyId: "aky_cli",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      userId: "user_approver",
    });
  });

  it("a CLI session key whose creator was removed from the org is invalid", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(cliKeyRow());
    mockQuery.orgUsers.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
    expect(mockQuery.workspaceUsers.findFirst).not.toHaveBeenCalled();
  });

  it("a CLI session key whose creator was removed from the key's workspace is invalid", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(cliKeyRow());
    mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ id: "ou_1" });
    mockQuery.workspaceUsers.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("a CLI session key with no recorded creator is invalid without a membership read", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(cliKeyRow(null));
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "invalid" });
    expect(mockQuery.orgUsers.findFirst).not.toHaveBeenCalled();
  });

  it("a key whose creator is recorded but whose purpose is not the CLI session carries no user", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_host",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
      scope: { purpose: "tacho_host_v1", host_enrollment_id: "tch_x" },
      createdById: "user_operator",
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toMatchObject({ ok: true, userId: null });
  });

  it("carries a user for the CLI session purpose and for no other purpose the tree mints", async () => {
    // The MCP surface now puts `resolveApiKey`'s `userId` on the context
    // instead of hard-coding null, so the blast radius of that change is
    // exactly the set of purposes this resolver attaches a user to. Every
    // purpose written to `auth.api_keys.scope` anywhere in the tree is listed
    // here, with where it is minted, so adding a sixth is a failing test
    // rather than a silent widening of who a machine key speaks for.
    const MINTED_PURPOSES: ReadonlyArray<[string, string]> = [
      // lib/tacho-host-enroll.ts
      ["tacho_host_v1", "Tacho host enrollment"],
      ["tacho_gateway_v1", "Tacho local MCP gateway"],
      // telemetry.stella.enroll.ts
      ["stella_operational_telemetry_v1", "Stella telemetry enrollment"],
    ];
    for (const [purpose, where] of MINTED_PURPOSES) {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
        id: "aky_machine",
        keyHash: sha256hex(RAW_KEY),
        orgId: "org_abc",
        workspaceId: "wrk_xyz",
        expiresAt: null,
        scope: { purpose },
        // A creator IS recorded on every one of these — an Owner or Admin
        // enrolled the machine. Attaching it is what would widen.
        createdById: "user_operator",
      });
      const result = await resolveApiKey(RAW_KEY);
      expect(result, where).toMatchObject({ ok: true, userId: null });
    }

    // A key with no purpose at all (create_api_key) is the fifth case, and it
    // carries no user either.
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_plain",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
      scope: {},
      createdById: "user_operator",
    });
    expect(await resolveApiKey(RAW_KEY)).toMatchObject({
      ok: true,
      userId: null,
    });

    // `agent_credential_v1`, the sixth, never resolves at all — see below.
  });

  it("an agent credential is refused as purpose_locked before any user is attached", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_agent",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
      scope: {
        purpose: "agent_credential_v1",
        agent_id: "agt_x",
        principal_id: "prn_x",
      },
      createdById: "user_admin",
    });
    const result = await resolveApiKey(RAW_KEY);
    expect(result).toEqual({ ok: false, kind: "purpose_locked" });
  });

  // -------------------------------------------------------------------------
  // ADR-105: a key does not authenticate into an archived workspace.
  // -------------------------------------------------------------------------

  it("refuses a key whose workspace is archived, however valid the key is", async () => {
    // The key hashes correctly, has no expiry and is not soft-deleted — the
    // exact shape that kept authenticating into an archived workspace before
    // ADR-105 (#3123). Archiving the workspace is what ends it.
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_stranded",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
      scope: {},
      createdById: "user_operator",
    });
    mockQuery.workspaces.findFirst.mockResolvedValue({
      id: "wrk_xyz",
      archivedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: false,
      kind: "workspace_archived",
    });
  });

  it("refuses a CLI session key into an archived workspace without reading membership", async () => {
    // The archived check runs before the membership reads, so a CLI key into
    // an archived workspace is refused on the same ground as any other key.
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(cliKeyRow("user_cli"));
    mockQuery.workspaces.findFirst.mockResolvedValue({
      id: "wrk_xyz",
      archivedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: false,
      kind: "workspace_archived",
    });
    expect(mockQuery.orgUsers.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a key whose workspace row cannot be read at all", async () => {
    // A scope that cannot be confirmed is not a scope. Failing closed here
    // keeps a deleted or unreadable workspace from behaving like an active one.
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_orphan",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_gone",
      expiresAt: null,
      scope: {},
      createdById: null,
    });
    mockQuery.workspaces.findFirst.mockResolvedValue(undefined);
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: false,
      kind: "workspace_archived",
    });
  });

  it("still resolves a key whose workspace is active", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_live",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
      scope: {},
      createdById: "user_operator",
    });
    expect(await resolveApiKey(RAW_KEY)).toEqual({
      ok: true,
      apiKeyId: "aky_live",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      userId: null,
    });
  });

  // -------------------------------------------------------------------------
  // ADR-145: Require SSO reaches API keys through the key's creator.
  // -------------------------------------------------------------------------
  describe("when the key's organization requires SSO", () => {
    const creatorKeyRow = (createdById: string | null = "user_member") => ({
      id: "aky_sso",
      keyHash: sha256hex(RAW_KEY),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
      scope: {},
      createdById,
    });
    const requireSso = () =>
      mockQuery.orgSecurityPolicy.findFirst.mockResolvedValueOnce({
        ssoRequired: true,
      });

    beforeEach(() => {
      mockOrgHasSso.mockReset();
      mockOrgHasSso.mockResolvedValue(true);
      selectMockResult = [];
    });

    it("resolves with one policy read and nothing else when the org does not require SSO", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      mockQuery.orgSecurityPolicy.findFirst.mockResolvedValueOnce({
        ssoRequired: false,
      });
      expect(await resolveApiKey(RAW_KEY)).toMatchObject({ ok: true });
      expect(mockQuery.orgSecurityPolicy.findFirst).toHaveBeenCalledTimes(1);
      expect(mockOrgHasSso).not.toHaveBeenCalled();
      expect(mockQuery.orgUsers.findFirst).not.toHaveBeenCalled();
      expect(fakeTx.select).not.toHaveBeenCalled();
    });

    it("resolves when the org requires SSO but its plan no longer includes it", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockOrgHasSso.mockResolvedValue(false);
      expect(await resolveApiKey(RAW_KEY)).toMatchObject({ ok: true });
      expect(mockQuery.orgUsers.findFirst).not.toHaveBeenCalled();
    });

    it("refuses a key whose creator is a member who never signed in through SSO", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ role: "member" });
      selectMockResult = [];
      expect(await resolveApiKey(RAW_KEY)).toEqual({
        ok: false,
        kind: "sso_required",
      });
    });

    it("resolves a key whose creator signed in through one of the org's verified providers", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ role: "member" });
      selectMockResult = [{ id: "acc_sso" }];
      expect(await resolveApiKey(RAW_KEY)).toEqual({
        ok: true,
        apiKeyId: "aky_sso",
        orgId: "org_abc",
        workspaceId: "wrk_xyz",
        userId: null,
      });
    });

    it("refuses a key whose creator's only SSO account is with another organization's provider", async () => {
      // The account lookup joins on this org's verified providers, so an
      // account from another org's provider matches no row.
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ role: "admin" });
      const builder = createMockBuilder();
      fakeTx.select.mockReturnValueOnce(builder);
      expect(await resolveApiKey(RAW_KEY)).toEqual({
        ok: false,
        kind: "sso_required",
      });
      expect(builder.innerJoin).toHaveBeenCalledTimes(1);
      const { schema } = await import("@oxagen/database");
      expect(builder.from).toHaveBeenCalledWith(schema.accounts);
      expect((builder.innerJoin.mock.calls[0] as unknown[])[0]).toBe(
        schema.ssoProviderTable,
      );
      // The predicate pins the provider to this org and to a verified domain.
      const { PgDialect } = await import("drizzle-orm/pg-core");
      const predicate = (builder.where.mock.calls[0] as unknown[])[0] as SQL;
      const where = new PgDialect().sqlToQuery(predicate);
      expect(where.sql).toContain('"sso_providers"."organization_id" = $');
      expect(where.sql).toContain('"sso_providers"."domain_verified" = $');
      expect(where.params).toEqual(
        expect.arrayContaining(["user_member", "org_abc", true]),
      );
    });

    it("resolves a key an Owner created without an SSO account (break-glass)", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ role: "Owner" });
      expect(await resolveApiKey(RAW_KEY)).toMatchObject({ ok: true });
      expect(fakeTx.select).not.toHaveBeenCalled();
    });

    it("resolves a key whose creator is an Owner by IAM assignment only", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ role: "member" });
      // The SSO-account read finds nothing; the IAM Owner read finds one.
      const noAccount = createMockBuilder();
      noAccount.limit = vi.fn(async () => []);
      fakeTx.select.mockReturnValueOnce(noAccount);
      selectMockResult = [{ id: "pra_owner" }];
      expect(await resolveApiKey(RAW_KEY)).toMatchObject({ ok: true });
      expect(noAccount.limit).toHaveBeenCalled();
      expect(fakeTx.select).toHaveBeenCalledTimes(2);
    });

    it("refuses a key whose creator is no longer a member of the org", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow());
      requireSso();
      mockQuery.orgUsers.findFirst.mockResolvedValueOnce(undefined);
      expect(await resolveApiKey(RAW_KEY)).toEqual({
        ok: false,
        kind: "sso_required",
      });
    });

    it("resolves a key with no creator without reading the policy", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(creatorKeyRow(null));
      mockQuery.orgSecurityPolicy.findFirst.mockResolvedValue({
        ssoRequired: true,
      });
      expect(await resolveApiKey(RAW_KEY)).toMatchObject({
        ok: true,
        userId: null,
      });
      expect(mockQuery.orgSecurityPolicy.findFirst).not.toHaveBeenCalled();
      mockQuery.orgSecurityPolicy.findFirst.mockReset();
    });

    it("refuses a CLI session key whose creator never signed in through SSO", async () => {
      mockQuery.apiKeys.findFirst.mockResolvedValueOnce(cliKeyRow());
      mockQuery.orgUsers.findFirst
        .mockResolvedValueOnce({ id: "ou_1" })
        .mockResolvedValueOnce({ role: "member" });
      mockQuery.workspaceUsers.findFirst.mockResolvedValueOnce({ id: "wsu_1" });
      requireSso();
      expect(await resolveApiKey(RAW_KEY)).toEqual({
        ok: false,
        kind: "sso_required",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Regression guard (the original prod bug): the lookup prefix is the fixed
  // 12-char leading window, NOT the substring before the first "_".
  // -------------------------------------------------------------------------
  it("derives the lookup prefix as the fixed 12-char window, not the chars before the first '_'", () => {
    expect(API_KEY_PREFIX_LENGTH).toBe(12);
    expect(apiKeyPrefix(RAW_KEY)).toBe(RAW_KEY.slice(0, API_KEY_PREFIX_LENGTH));
    expect(apiKeyPrefix(RAW_KEY)).toBe(RAW_KEY_PREFIX);
    // The old, buggy implementation produced just "ox" — must never happen.
    expect(apiKeyPrefix(RAW_KEY)).not.toBe(
      RAW_KEY.slice(0, RAW_KEY.indexOf("_")),
    );
    expect(apiKeyPrefix(RAW_KEY)).not.toBe("ox");
  });

  it("reaches the DB for a well-formed key (the prefix window passes the malformed guard)", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(undefined);
    await resolveApiKey(RAW_KEY);
    // The live lookup, then, because it found nothing, the lookup of a
    // revoked host's retired key. Both read by the same indexed prefix.
    expect(mockQuery.apiKeys.findFirst).toHaveBeenCalledTimes(2);
  });

  it("reads the key table once when the live lookup finds a row", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_once",
      keyHash: sha256hex(`${RAW_KEY}_other`),
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: null,
    });
    await resolveApiKey(RAW_KEY);
    expect(mockQuery.apiKeys.findFirst).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resolveOrgScope
// ---------------------------------------------------------------------------

describe("resolveOrgScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMockResult = [];
  });

  it("returns not_found when the org slug does not exist", async () => {
    selectMockResult = [];
    const result = await resolveOrgScope("usr_1", "ghost-org");
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });

  it("returns not_found when the user is not in the org", async () => {
    selectMockResult = [];
    const result = await resolveOrgScope("usr_stranger", "real-org");
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });

  it("returns orgId when the user is a member", async () => {
    selectMockResult = [{ orgId: "org_real" }];
    const result = await resolveOrgScope("usr_member", "real-org");
    expect(result).toEqual({ ok: true, orgId: "org_real" });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant isolation: user A must not resolve org B's scope even when
  // they are a member of org A and org B exists.
  // -------------------------------------------------------------------------
  it("cross-tenant isolation: user from org A cannot resolve org B", async () => {
    selectMockResult = [];
    const result = await resolveOrgScope("usr_a", "org-b-slug");
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });

  it("cross-tenant isolation: two calls in sequence are independently scoped", async () => {
    // Call 1: user_a resolves org_a (member).
    selectMockResult = [{ orgId: "org_a" }];
    const result1 = await resolveOrgScope("usr_a", "org-a-slug");
    expect(result1).toEqual({ ok: true, orgId: "org_a" });

    // Call 2: same user tries to resolve org_b (not a member).
    selectMockResult = [];
    const result2 = await resolveOrgScope("usr_a", "org-b-slug");
    expect(result2).toEqual({ ok: false, kind: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceScope
// ---------------------------------------------------------------------------

describe("resolveWorkspaceScope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_found when no workspace matches org+slug", async () => {
    mockQuery.workspaces.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveWorkspaceScope("org_1", "ghost-ws");
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });

  it("returns workspaceId for a matching workspace (no userId — legacy path)", async () => {
    mockQuery.workspaces.findFirst.mockResolvedValueOnce({ id: "wrk_abc" });
    const result = await resolveWorkspaceScope("org_1", "my-workspace");
    expect(result).toEqual({ ok: true, workspaceId: "wrk_abc" });
  });

  it("returns workspaceId when userId is a member", async () => {
    mockQuery.workspaces.findFirst.mockResolvedValueOnce({ id: "wrk_abc" });
    mockQuery.workspaceUsers.findFirst.mockResolvedValueOnce({ id: "wsu_xyz" });
    const result = await resolveWorkspaceScope(
      "org_1",
      "my-workspace",
      "usr_1",
    );
    expect(result).toEqual({ ok: true, workspaceId: "wrk_abc" });
  });

  it("returns not_member when userId is not a member of the workspace", async () => {
    // Workspace exists in the org, but the user is not a member.
    mockQuery.workspaces.findFirst.mockResolvedValueOnce({ id: "wrk_beta" });
    mockQuery.workspaceUsers.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveWorkspaceScope("org_1", "ws-beta", "usr_alpha");
    expect(result).toEqual({ ok: false, kind: "not_member" });
  });

  it("skips membership check when userId is null", async () => {
    // API-key requests pass null — should still resolve successfully.
    mockQuery.workspaces.findFirst.mockResolvedValueOnce({ id: "wrk_abc" });
    const result = await resolveWorkspaceScope("org_1", "my-workspace", null);
    expect(result).toEqual({ ok: true, workspaceId: "wrk_abc" });
    expect(mockQuery.workspaceUsers.findFirst).not.toHaveBeenCalled();
  });

  it("skips membership check when userId is undefined", async () => {
    // Backward-compatible default — no userId arg behaves like the old API.
    mockQuery.workspaces.findFirst.mockResolvedValueOnce({ id: "wrk_abc" });
    const result = await resolveWorkspaceScope(
      "org_1",
      "my-workspace",
      undefined,
    );
    expect(result).toEqual({ ok: true, workspaceId: "wrk_abc" });
    expect(mockQuery.workspaceUsers.findFirst).not.toHaveBeenCalled();
  });

  it("cross-tenant isolation: slug that exists in org_b returns not_found when scoped to org_a", async () => {
    // The DB query is always scoped to the passed orgId. Simulate a slug
    // that exists in org_b but the query was issued with org_a — the
    // composite index (org_id, slug) means the DB returns no row.
    mockQuery.workspaces.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveWorkspaceScope("org_a", "slug-in-org-b");
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });
});
