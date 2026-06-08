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

// ---------------------------------------------------------------------------
// DB mock — hoisted so imports in the resolvers see the mock immediately.
// ---------------------------------------------------------------------------

const mockQuery = {
  sessions: { findFirst: vi.fn() },
  apiKeys: { findFirst: vi.fn() },
  organizations: { findFirst: vi.fn() },
  orgUsers: { findFirst: vi.fn() },
  workspaces: { findFirst: vi.fn() },
};

const fakeTx = { query: mockQuery };

vi.mock("@oxagen/database", () => ({
  db: () => fakeTx,
  withSystemDb: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
  schema: {
    sessions: { token: "sessions.token" },
    apiKeys: { keyPrefix: "apiKeys.keyPrefix", deletedAt: "apiKeys.deletedAt" },
    organizations: { slug: "organizations.slug" },
    orgUsers: { orgId: "orgUsers.orgId", userId: "orgUsers.userId" },
    workspaces: { orgId: "workspaces.orgId", slug: "workspaces.slug" },
  },
}));

// Import resolvers after the mock is registered.
import {
  resolveSession,
  parseSessionCookie,
  stripCookieSignature,
  SESSION_COOKIE_NAME,
  resolveApiKey,
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
    // OXA-1497: was "better-auth.session_token" which never matched the real
    // cookie because auth.ts sets advanced.cookiePrefix = "oxagen".
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

  it("does NOT match the old default 'better-auth.session_token' cookie name (OXA-1497 regression guard)", () => {
    // If the cookie is named with the old default prefix it must not be found.
    const rawToken = "abc123";
    const signed = makeSignedCookieValue(rawToken);
    const header = `better-auth.session_token=${signed}`;
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
// ---------------------------------------------------------------------------

describe("resolveApiKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns malformed when there is no underscore separator", async () => {
    const result = await resolveApiKey("noseparatorhere");
    expect(result).toEqual({ ok: false, kind: "malformed" });
    expect(mockQuery.apiKeys.findFirst).not.toHaveBeenCalled();
  });

  it("returns invalid when no row matches the prefix", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveApiKey("pfx_secret");
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("returns invalid when the hash does not match", async () => {
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_1",
      keyHash: sha256hex("pfx_WRONG_SECRET"),
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: null,
    });
    const result = await resolveApiKey("pfx_correct_secret");
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });

  it("returns expired when the key has passed its expiry", async () => {
    const rawKey = "pfx_mysecret";
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_2",
      keyHash: sha256hex(rawKey),
      orgId: "org_1",
      workspaceId: "wrk_1",
      expiresAt: pastDate(),
    });
    const result = await resolveApiKey(rawKey);
    expect(result).toEqual({ ok: false, kind: "expired" });
  });

  it("returns ok with scope for a valid non-expiring key", async () => {
    const rawKey = "pfx_valid_secret";
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_3",
      keyHash: sha256hex(rawKey),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: null,
    });
    const result = await resolveApiKey(rawKey);
    expect(result).toEqual({
      ok: true,
      apiKeyId: "aky_3",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
    });
  });

  it("returns ok for a valid key that has not yet expired", async () => {
    const rawKey = "pfx_fresh_secret";
    mockQuery.apiKeys.findFirst.mockResolvedValueOnce({
      id: "aky_4",
      keyHash: sha256hex(rawKey),
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
      expiresAt: futureDate(3_600_000),
    });
    const result = await resolveApiKey(rawKey);
    expect(result).toEqual({
      ok: true,
      apiKeyId: "aky_4",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveOrgScope
// ---------------------------------------------------------------------------

describe("resolveOrgScope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not_found when the org slug does not exist", async () => {
    mockQuery.organizations.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveOrgScope("usr_1", "ghost-org");
    expect(result).toEqual({ ok: false, kind: "not_found" });
    expect(mockQuery.orgUsers.findFirst).not.toHaveBeenCalled();
  });

  it("returns not_found when the user is not in the org", async () => {
    mockQuery.organizations.findFirst.mockResolvedValueOnce({ id: "org_real" });
    mockQuery.orgUsers.findFirst.mockResolvedValueOnce(undefined);
    const result = await resolveOrgScope("usr_stranger", "real-org");
    expect(result).toEqual({ ok: false, kind: "not_found" });
  });

  it("returns orgId when the user is a member", async () => {
    mockQuery.organizations.findFirst.mockResolvedValueOnce({ id: "org_real" });
    mockQuery.orgUsers.findFirst.mockResolvedValueOnce({ id: "oru_1" });
    const result = await resolveOrgScope("usr_member", "real-org");
    expect(result).toEqual({ ok: true, orgId: "org_real" });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant isolation: user A must not resolve org B's scope even when
  // they are a member of org A and org B exists.
  // -------------------------------------------------------------------------
  it("cross-tenant isolation: user from org A cannot resolve org B", async () => {
    // Simulate org B existing and the membership check returning no row,
    // because user_a is NOT a member of org B.
    mockQuery.organizations.findFirst.mockResolvedValueOnce({ id: "org_b" });
    mockQuery.orgUsers.findFirst.mockResolvedValueOnce(undefined);

    const result = await resolveOrgScope("usr_a", "org-b-slug");

    expect(result).toEqual({ ok: false, kind: "not_found" });

    // Ensure the membership query was scoped to org_b — the mock validates
    // that it was called once (if it had been skipped, cross-tenant data
    // would be accessible without a membership check).
    expect(mockQuery.orgUsers.findFirst).toHaveBeenCalledOnce();
  });

  it("cross-tenant isolation: two calls in sequence are independently scoped", async () => {
    // Call 1: user_a resolves org_a (member).
    mockQuery.organizations.findFirst
      .mockResolvedValueOnce({ id: "org_a" })
      .mockResolvedValueOnce({ id: "org_b" });
    mockQuery.orgUsers.findFirst
      .mockResolvedValueOnce({ id: "oru_member_a" }) // user_a IS member of org_a
      .mockResolvedValueOnce(undefined); // user_a is NOT member of org_b

    const resultA = await resolveOrgScope("usr_a", "org-a-slug");
    expect(resultA).toEqual({ ok: true, orgId: "org_a" });

    // Call 2: same user tries org_b — must be rejected.
    const resultB = await resolveOrgScope("usr_a", "org-b-slug");
    expect(resultB).toEqual({ ok: false, kind: "not_found" });
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

  it("returns workspaceId for a matching workspace", async () => {
    mockQuery.workspaces.findFirst.mockResolvedValueOnce({ id: "wrk_abc" });
    const result = await resolveWorkspaceScope("org_1", "my-workspace");
    expect(result).toEqual({ ok: true, workspaceId: "wrk_abc" });
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
