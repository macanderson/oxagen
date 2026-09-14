/**
 * actions.test.ts — unit tests for the CLI browser-login server actions.
 *
 * Tests cover:
 *   approveCliAuth:
 *     - invalid redirect_uri → throws (no redirect)
 *     - invalid code_challenge → throws
 *     - invalid code_challenge_method → throws
 *     - missing state → throws
 *     - no session → redirects to /login
 *     - workspace not found → throws
 *     - user not a workspace member → throws
 *     - user lacks API-key permission → throws
 *     - happy path → createCliAuthCode called, redirect to loopback with code+state
 *
 *   cancelCliAuth:
 *     - invalid redirect_uri → throws
 *     - happy path → redirect to loopback with error=access_denied+state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockRedirect,
  mockWithSystemDb,
  mockRunInTenantScope,
  mockGenerateCliAuthCode,
  mockCreateCliAuthCode,
  mockIsLoopbackRedirectUri,
  mockIsValidCodeChallenge,
  mockActorCanManageApiKeys,
} = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn(),
    mockRedirect: vi.fn((url: string) => {
      // Mirror Next.js: throw so callers see the redirect in tests.
      throw new Error(`REDIRECT:${url}`);
    }),
    mockWithSystemDb: vi.fn(),
    mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
    mockGenerateCliAuthCode: vi.fn().mockReturnValue("test-code-abc"),
    mockCreateCliAuthCode: vi.fn().mockResolvedValue(undefined),
    // Default: validate as true; individual tests override.
    mockIsLoopbackRedirectUri: vi.fn().mockReturnValue(true),
    mockIsValidCodeChallenge: vi.fn().mockReturnValue(true),
    mockActorCanManageApiKeys: vi.fn().mockResolvedValue(true),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/session", () => ({
  getSession: mockGetSession,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mockWithSystemDb,
  schema: {
    organizations: {
      id: "organizations.id",
      slug: "organizations.slug",
    },
    workspaces: {
      id: "workspaces.id",
      orgId: "workspaces.org_id",
      slug: "workspaces.slug",
    },
    workspaceUsers: {
      workspaceId: "workspace_users.workspace_id",
      userId: "workspace_users.user_id",
      id: "workspace_users.id",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(
    (_col: unknown, _val: unknown) => `eq(${String(_col)},${String(_val)})`,
  ),
  and: vi.fn((...args: unknown[]) => `and(${args.join(",")})`),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mockRunInTenantScope,
}));

vi.mock("@oxagen/auth/cli-auth", () => ({
  generateCliAuthCode: mockGenerateCliAuthCode,
  createCliAuthCode: mockCreateCliAuthCode,
  isLoopbackRedirectUri: mockIsLoopbackRedirectUri,
  isValidCodeChallenge: mockIsValidCodeChallenge,
  CLI_AUTH_PKCE_METHOD: "S256",
}));

vi.mock("@oxagen/handlers", () => ({
  actorCanManageApiKeys: mockActorCanManageApiKeys,
}));

// ---------------------------------------------------------------------------
// Import module under test after mocks are set up
// ---------------------------------------------------------------------------

import { approveCliAuth, cancelCliAuth } from "./actions";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_REDIRECT_URI = "http://127.0.0.1:51234/callback";
const VALID_STATE = "abc123";
const VALID_CHALLENGE = "a".repeat(43); // 43-char base64url — passes mock validator
const VALID_METHOD = "S256";
const VALID_LABEL = "my-macbook";
const VALID_ORG_SLUG = "acme";
const VALID_WS_SLUG = "main";

const USER_ID = "user-uuid-1";
const ORG_ID = "org-uuid-1";
const WS_ID = "ws-uuid-1";

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("redirect_uri", VALID_REDIRECT_URI);
  fd.set("state", VALID_STATE);
  fd.set("code_challenge", VALID_CHALLENGE);
  fd.set("code_challenge_method", VALID_METHOD);
  fd.set("label", VALID_LABEL);
  fd.set("org_slug", VALID_ORG_SLUG);
  fd.set("workspace_slug", VALID_WS_SLUG);
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

// ---------------------------------------------------------------------------
// Default happy-path DB stubs
// ---------------------------------------------------------------------------

function setupHappyPathDb() {
  // resolveCliAuthScope: org lookup (call 0), workspace lookup (call 1)
  // assertCliWorkspaceMember: workspace_users lookup (call 2)
  let callIdx = 0;
  mockWithSystemDb.mockImplementation((_fn: (tx: unknown) => unknown) => {
    const idx = callIdx++;
    if (idx === 0) {
      // org rows
      const tx = buildSelectChain([{ id: ORG_ID }]);
      return _fn(tx);
    }
    if (idx === 1) {
      // workspace rows
      const tx = buildSelectChain([{ id: WS_ID }]);
      return _fn(tx);
    }
    // workspace_users membership rows
    const tx = buildSelectChain([{ id: "wu-1" }]);
    return _fn(tx);
  });
}

/**
 * Build a minimal Drizzle query chain that resolves to `rows`.
 * Each call to a query builder method (select, from, where, innerJoin, leftJoin,
 * limit, orderBy) returns `this` so chaining works.
 */
function buildSelectChain(rows: unknown[]): unknown {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.from = self;
  chain.where = self;
  chain.innerJoin = self;
  chain.leftJoin = self;
  chain.limit = () => Promise.resolve(rows);
  chain.orderBy = () => Promise.resolve(rows);
  return chain;
}

// ---------------------------------------------------------------------------
// approveCliAuth tests
// ---------------------------------------------------------------------------

describe("approveCliAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockIsLoopbackRedirectUri.mockReturnValue(true);
    mockIsValidCodeChallenge.mockReturnValue(true);
    mockActorCanManageApiKeys.mockResolvedValue(true);
    mockGenerateCliAuthCode.mockReturnValue("test-code-abc");
    mockCreateCliAuthCode.mockResolvedValue(undefined);
    mockRunInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
  });

  it("throws on invalid redirect_uri (never redirects)", async () => {
    mockIsLoopbackRedirectUri.mockReturnValue(false);
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "Invalid redirect_uri",
    );
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws on invalid code_challenge", async () => {
    mockIsValidCodeChallenge.mockReturnValue(false);
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "Invalid code_challenge",
    );
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws on invalid code_challenge_method", async () => {
    await expect(
      approveCliAuth(makeFormData({ code_challenge_method: "plain" })),
    ).rejects.toThrow("Invalid code_challenge_method");
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws on missing state", async () => {
    await expect(approveCliAuth(makeFormData({ state: "" }))).rejects.toThrow(
      "Missing state",
    );
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("redirects to /login when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "REDIRECT:/login",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/login");
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws when org is not found", async () => {
    let callIdx = 0;
    mockWithSystemDb.mockImplementation((_fn: (tx: unknown) => unknown) => {
      callIdx++;
      if (callIdx === 1) {
        // org lookup returns empty
        return _fn(buildSelectChain([]));
      }
      return _fn(buildSelectChain([]));
    });
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "Workspace not found",
    );
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws when workspace is not found", async () => {
    let callIdx = 0;
    mockWithSystemDb.mockImplementation((_fn: (tx: unknown) => unknown) => {
      callIdx++;
      if (callIdx === 1) {
        // org found
        return _fn(buildSelectChain([{ id: ORG_ID }]));
      }
      // workspace not found
      return _fn(buildSelectChain([]));
    });
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "Workspace not found",
    );
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws when user is not a workspace member", async () => {
    let callIdx = 0;
    mockWithSystemDb.mockImplementation((_fn: (tx: unknown) => unknown) => {
      callIdx++;
      if (callIdx === 1) return _fn(buildSelectChain([{ id: ORG_ID }]));
      if (callIdx === 2) return _fn(buildSelectChain([{ id: WS_ID }]));
      // membership check returns empty — not a member
      return _fn(buildSelectChain([]));
    });
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "not a member",
    );
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("throws when user lacks API-key management permission", async () => {
    setupHappyPathDb();
    mockActorCanManageApiKeys.mockResolvedValue(false);
    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      "permission to create API keys",
    );
    expect(mockCreateCliAuthCode).not.toHaveBeenCalled();
  });

  it("happy path: mints code, calls createCliAuthCode with correct data, redirects to loopback", async () => {
    setupHappyPathDb();

    await expect(approveCliAuth(makeFormData())).rejects.toThrow(
      `REDIRECT:${VALID_REDIRECT_URI}?code=test-code-abc&state=${encodeURIComponent(VALID_STATE)}`,
    );

    expect(mockGenerateCliAuthCode).toHaveBeenCalledOnce();
    expect(mockCreateCliAuthCode).toHaveBeenCalledOnce();

    const [code, data, nowArg] = mockCreateCliAuthCode.mock.calls[0] as [
      string,
      unknown,
      number,
    ];
    expect(code).toBe("test-code-abc");
    expect(data).toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      workspaceId: WS_ID,
      orgSlug: VALID_ORG_SLUG,
      workspaceSlug: VALID_WS_SLUG,
      codeChallenge: VALID_CHALLENGE,
      redirectUri: VALID_REDIRECT_URI,
      label: VALID_LABEL,
    });
    expect(typeof nowArg).toBe("number");
    expect(nowArg).toBeGreaterThan(0);

    // Redirect goes to loopback with code + state
    expect(mockRedirect).toHaveBeenCalledWith(
      `${VALID_REDIRECT_URI}?code=${encodeURIComponent("test-code-abc")}&state=${encodeURIComponent(VALID_STATE)}`,
    );
  });

  it("wraps actorCanManageApiKeys in runInTenantScope with ORG_ONLY_WS sentinel", async () => {
    setupHappyPathDb();

    await expect(approveCliAuth(makeFormData())).rejects.toThrow("REDIRECT:");

    expect(mockRunInTenantScope).toHaveBeenCalledOnce();
    const [scope] = mockRunInTenantScope.mock.calls[0] as [
      { orgId: string; workspaceId: string },
      unknown,
    ];
    expect(scope.orgId).toBe(ORG_ID);
    // Must use the org-only sentinel (not a real workspace id)
    expect(scope.workspaceId).toBe("00000000-0000-0000-0000-000000000000");
  });
});

// ---------------------------------------------------------------------------
// cancelCliAuth tests
// ---------------------------------------------------------------------------

describe("cancelCliAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLoopbackRedirectUri.mockReturnValue(true);
  });

  it("throws on invalid redirect_uri (never redirects)", async () => {
    mockIsLoopbackRedirectUri.mockReturnValue(false);
    const fd = new FormData();
    fd.set("redirect_uri", "https://evil.example.com/cb");
    fd.set("state", "x");
    await expect(cancelCliAuth(fd)).rejects.toThrow("Invalid redirect_uri");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects to loopback with error=access_denied and state", async () => {
    const fd = new FormData();
    fd.set("redirect_uri", VALID_REDIRECT_URI);
    fd.set("state", VALID_STATE);
    await expect(cancelCliAuth(fd)).rejects.toThrow(
      `REDIRECT:${VALID_REDIRECT_URI}?error=access_denied&state=${encodeURIComponent(VALID_STATE)}`,
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      `${VALID_REDIRECT_URI}?error=access_denied&state=${encodeURIComponent(VALID_STATE)}`,
    );
  });

  it("URL-encodes the state value in the cancel redirect", async () => {
    const specialState = "state with spaces & special=chars";
    const fd = new FormData();
    fd.set("redirect_uri", VALID_REDIRECT_URI);
    fd.set("state", specialState);
    await expect(cancelCliAuth(fd)).rejects.toThrow("REDIRECT:");
    expect(mockRedirect).toHaveBeenCalledWith(
      `${VALID_REDIRECT_URI}?error=access_denied&state=${encodeURIComponent(specialState)}`,
    );
  });
});
