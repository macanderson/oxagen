/**
 * Unit tests for src/routes/v1/github-oauth.ts
 *
 * Covers:
 * - GET /v1/:org/:ws/connections/github/auth-url
 *   - missing connectionId → 400
 *   - missing env vars → 503
 *   - happy path → returns authUrl with correct client_id, scope, state, redirect_uri
 *   - state HMAC is a sha256 hex of the state JSON
 *   - state is base64url-encoded JSON
 *
 * - GET /oauth/github/callback
 *   - missing code or state → 400
 *   - missing env vars → 503
 *   - state with bad base64url → 400
 *   - state HMAC mismatch → 400
 *   - expired state → 400
 *   - GitHub token exchange failure (non-200) → 502
 *   - GitHub token exchange error field → 400
 *   - happy path → stores tokens + redirects to app with setup=github query
 *
 * - GET /v1/:org/:ws/connections/github/installations
 *   - missing connectionId → 400
 *   - connection not found → 404
 *   - GitHub API error → 502
 *   - happy path → returns installations list
 *   - paginates when total_count > 100
 *
 * - GET /v1/:org/:ws/connections/github/installations/:id/repositories
 *   - missing connectionId → 400
 *   - connection not found → 404
 *   - GitHub API error → 502
 *   - happy path → returns repositories list with totalCount
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const mocks = vi.hoisted(() => ({
  // Auth
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  // Billing
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
  // DB
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  // Crypto
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  // Env
  requireEnv: vi.fn(),
  // Fetch
  fetch: vi.fn(),
}));

// ── module mocks (must be hoisted before imports) ─────────────────────────────

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(),
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
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("@oxagen/crypto", () => ({
  encrypt: mocks.encrypt,
  decrypt: mocks.decrypt,
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
}));

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/config/env")>();
  return {
    ...real,
    requireEnv: mocks.requireEnv,
  };
});

vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: { send: vi.fn() },
}));
vi.mock("@oxagen/inngest-functions", () => ({
  inngest: { send: vi.fn(), createFunction: vi.fn() },
  functions: [],
}));
vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: vi.fn(() => ({ verifyWebhook: vi.fn().mockReturnValue(true) })),
}));

// Stub global fetch for GitHub API calls
global.fetch = mocks.fetch as unknown as typeof fetch;

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

// ── constants ─────────────────────────────────────────────────────────────────

const ORG = "test-org";
const WS = "test-ws";
const BASE = `/v1/${ORG}/${WS}/connections/github`;
const CALLBACK_PATH = "/oauth/github/callback";

const STATE_SECRET = "test-state-secret-32-bytes-long!1";
const CLIENT_ID = "Iv1.test_github_client_id";
const CLIENT_SECRET = "test_github_client_secret";
const APP_URL = "https://app.test.oxagen.ai";
const API_URL = "https://api.test.oxagen.ai";

const DEFAULT_ENV = {
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  GITHUB_APP_INSTALL_STATE_SECRET: STATE_SECRET,
  NEXT_PUBLIC_APP_URL: APP_URL,
  NEXT_PUBLIC_API_URL: API_URL,
};

// ── helpers ───────────────────────────────────────────────────────────────────

function authGet(path: string) {
  return app.fetch(
    makeRequest(path, { headers: { authorization: bearerHeader("oxk_test") } }),
  );
}

/**
 * Build a mock Drizzle chain for withTenantDb / withSystemDb.
 * Supports .select().from().innerJoin().where().limit() patterns.
 * Also supports .insert().values().onConflictDoUpdate().returning() patterns.
 */
function makeTxChain(rows: unknown[]) {
  const updateChain = {
    set: vi.fn(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  updateChain.set.mockReturnValue(updateChain);

  const insertChain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  insertChain.values.mockReturnValue(insertChain);
  insertChain.onConflictDoUpdate.mockReturnValue(insertChain);

  const selectChain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.innerJoin.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);

  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    execute: vi.fn().mockResolvedValue([]),
  };
}

type TxLike = ReturnType<typeof makeTxChain>;
type DbFn = (fn: (tx: TxLike) => Promise<unknown>) => Promise<unknown>;

/** Build a valid state string (base64url JSON + "." + HMAC). */
function buildValidState(
  overrides: Partial<{
    orgId: string;
    workspaceId: string;
    connectionId: string;
    expiresAt: number;
    nonce: string;
  }> = {},
): string {
  const stateJson = JSON.stringify({
    orgId: "org-id-test",
    workspaceId: "ws-id-test",
    connectionId: "con_ABC",
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: "test-nonce-uuid",
    ...overrides,
  });
  const hmac = createHmac("sha256", STATE_SECRET).update(stateJson).digest("hex");
  const encoded = Buffer.from(stateJson).toString("base64url");
  return `${encoded}.${hmac}`;
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Auth: API key resolves org+workspace
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());

  // Env: return DEFAULT_ENV by default
  mocks.requireEnv.mockReturnValue(DEFAULT_ENV);

  // Crypto: simple pass-through stubs
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "ingestion:env:v1",
  });
  mocks.encrypt.mockResolvedValue(Buffer.from("encrypted-token"));
  mocks.decrypt.mockResolvedValue(Buffer.from("decrypted-access-token"));

  // DB: return empty by default
  mocks.withTenantDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
    fn(makeTxChain([]) as TxLike),
  );
  mocks.withSystemDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
    fn(makeTxChain([]) as TxLike),
  );

  // Fetch: default to 200 OK JSON
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
});

// ── GET /connections/github/auth-url ──────────────────────────────────────────

describe("GET /connections/github/auth-url", () => {
  it("returns 400 when connectionId is missing", async () => {
    const res = await authGet(`${BASE}/auth-url`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("connectionId");
  });

  it("returns 503 when GITHUB_APP_CLIENT_ID is missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_CLIENT_ID: undefined,
    });
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("returns 503 when GITHUB_APP_INSTALL_STATE_SECRET is missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_INSTALL_STATE_SECRET: undefined,
    });
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(503);
  });

  it("returns authUrl with correct client_id and scope on happy path", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = await res.json() as { authUrl: string };
    expect(body.authUrl).toContain("github.com/login/oauth/authorize");
    expect(body.authUrl).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(body.authUrl).toContain("scope=repo");
  });

  it("includes redirect_uri pointing to /oauth/github/callback", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    const body = await res.json() as { authUrl: string };
    const url = new URL(body.authUrl);
    const redirectUri = url.searchParams.get("redirect_uri") ?? decodeURIComponent(url.href.match(/redirect_uri=([^&]+)/)?.[1] ?? "");
    expect(redirectUri).toContain("/oauth/github/callback");
  });

  it("state encodes the connectionId + orgId + workspaceId as base64url JSON", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_MYCONN`);
    const body = await res.json() as { authUrl: string };
    const urlStr = body.authUrl;
    const stateMatch = urlStr.match(/[?&]state=([^&]+)/);
    expect(stateMatch).not.toBeNull();

    const rawState = decodeURIComponent(stateMatch![1]!);
    // Format: "{base64url_json}.{hmac}"
    const dotIdx = rawState.lastIndexOf(".");
    expect(dotIdx).toBeGreaterThan(0);

    const encodedState = rawState.slice(0, dotIdx);
    const receivedHmac = rawState.slice(dotIdx + 1);

    const stateJson = Buffer.from(encodedState, "base64url").toString("utf8");
    const statePayload = JSON.parse(stateJson) as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      expiresAt: number;
      nonce: string;
    };

    expect(statePayload.connectionId).toBe("con_MYCONN");
    expect(statePayload.orgId).toBeDefined();
    expect(statePayload.workspaceId).toBeDefined();
    expect(statePayload.expiresAt).toBeGreaterThan(Date.now());

    // HMAC should match
    const expectedHmac = createHmac("sha256", STATE_SECRET).update(stateJson).digest("hex");
    expect(receivedHmac).toBe(expectedHmac);
  });

  it("expiresAt is ~10 minutes in the future", async () => {
    const before = Date.now();
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    const after = Date.now();
    const body = await res.json() as { authUrl: string };

    const rawState = decodeURIComponent(body.authUrl.match(/[?&]state=([^&]+)/)![1]!);
    const dotIdx = rawState.lastIndexOf(".");
    const stateJson = Buffer.from(rawState.slice(0, dotIdx), "base64url").toString("utf8");
    const { expiresAt } = JSON.parse(stateJson) as { expiresAt: number };

    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 100);
  });
});

// ── GET /oauth/github/callback ────────────────────────────────────────────────

describe("GET /oauth/github/callback", () => {
  function makeCallbackReq(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return app.fetch(makeRequest(`${CALLBACK_PATH}?${qs}`));
  }

  it("returns 400 when code is missing", async () => {
    const res = await makeCallbackReq({ state: buildValidState() });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Missing");
  });

  it("returns 400 when state is missing", async () => {
    const res = await makeCallbackReq({ code: "test-code" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Missing");
  });

  it("returns 503 when GitHub App env vars are missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_CLIENT_ID: undefined,
    });
    const res = await makeCallbackReq({ code: "code", state: buildValidState() });
    expect(res.status).toBe(503);
  });

  it("returns 400 when state format is invalid (no dot separator)", async () => {
    const res = await makeCallbackReq({ code: "code", state: "nodotseparator" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Invalid state format");
  });

  it("returns 400 when state base64url decoding fails", async () => {
    const res = await makeCallbackReq({ code: "code", state: "!!!invalid_base64!!!.abc123" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when state HMAC does not match", async () => {
    const validState = buildValidState();
    const dotIdx = validState.lastIndexOf(".");
    const tampered = `${validState.slice(0, dotIdx)}.deadbeefdeadbeef`;
    const res = await makeCallbackReq({ code: "code", state: tampered });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("signature");
  });

  it("returns 400 when state is expired", async () => {
    const expiredState = buildValidState({ expiresAt: Date.now() - 1000 });
    const res = await makeCallbackReq({ code: "code", state: expiredState });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("expired");
  });

  it("returns 502 when GitHub token exchange API returns non-200", async () => {
    // First call (GitHub user: will not be reached) — we need token exchange to fail
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    const res = await makeCallbackReq({ code: "code", state: buildValidState() });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("503");
  });

  it("returns 400 when GitHub token exchange returns error field", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: "bad_verification_code", error_description: "Code already used" }),
    });

    const res = await makeCallbackReq({ code: "code", state: buildValidState() });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Code already used");
  });

  it("happy path: exchanges code, stores tokens, and redirects to app", async () => {
    // Token exchange
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_abc123",
          refresh_token: "ghr_xyz789",
          expires_in: 28800,
          token_type: "Bearer",
          scope: "repo,read:org",
        }),
      })
      // GitHub user info fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 12345, login: "testuser", email: "test@test.com", name: "Test User" }),
      });

    // DB: source_connection found
    const connRow = { id: "uuid-conn-1", orgId: "org-id-test", workspaceId: "ws-id-test" };
    // oauthAccounts insert
    const oauthRow = { id: "uuid-oauth-1" };
    // orgs slug
    const orgSlugRow = { slug: "my-org" };
    // workspaces slug
    const wsSlugRow = { slug: "my-ws" };

    // withSystemDb calls in order: source_connections lookup, oauth upsert, oauth update, org slug, ws slug
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) => fn(makeTxChain([connRow]) as TxLike))
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) => fn(makeTxChain([oauthRow]) as TxLike))
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) => fn(makeTxChain([]) as TxLike))   // UPDATE source_connections
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) => fn(makeTxChain([orgSlugRow]) as TxLike))
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) => fn(makeTxChain([wsSlugRow]) as TxLike));

    const res = await makeCallbackReq({ code: "auth-code", state: buildValidState() });

    // Should redirect (302)
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/knowledge/sources");
    expect(location).toContain("setup=github");
    expect(location).toContain("connectionId=con_ABC");

    // encrypt should have been called twice: once for access_token, once for refresh_token
    expect(mocks.encrypt).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when source_connection is not found", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "ghs_abc123",
        token_type: "Bearer",
        scope: "repo",
      }),
    });
    // GitHub user
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 12345, login: "user" }),
    });

    // source_connections lookup returns empty
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );

    const res = await makeCallbackReq({ code: "auth-code", state: buildValidState() });
    expect(res.status).toBe(404);
  });
});

// ── GET /connections/github/installations ─────────────────────────────────────

describe("GET /connections/github/installations", () => {
  it("returns 400 when connectionId is missing", async () => {
    const res = await authGet(`${BASE}/installations`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("connectionId");
  });

  it("returns 404 when connection is not found in DB", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );
    const res = await authGet(`${BASE}/installations?connectionId=con_MISSING`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when accessTokenEnc is null", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: null }]) as TxLike),
    );
    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("token not found");
  });

  it("returns 502 when GitHub API fails", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } }]) as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("401");
  });

  it("returns installations list on happy path", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } }]) as TxLike),
    );

    const ghResponse = {
      total_count: 2,
      installations: [
        {
          id: 111,
          account: { login: "acme-org", type: "Organization", avatar_url: "https://avatars.gh.com/111" },
          repository_selection: "all",
        },
        {
          id: 222,
          account: { login: "bob", type: "User", avatar_url: "https://avatars.gh.com/222" },
          repository_selection: "selected",
        },
      ],
    };
    mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ghResponse });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      installations: Array<{
        id: number;
        accountLogin: string;
        accountType: string;
        repositorySelection: string;
        avatarUrl: string;
      }>;
    };
    expect(body.installations).toHaveLength(2);
    expect(body.installations[0]!.accountLogin).toBe("acme-org");
    expect(body.installations[0]!.accountType).toBe("Organization");
    expect(body.installations[0]!.repositorySelection).toBe("all");
    expect(body.installations[1]!.id).toBe(222);
  });

  it("paginates when total_count exceeds 100", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } }]) as TxLike),
    );

    // Page 1: 100 installations
    const page1Installations = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: { login: `org-${i + 1}`, type: "Organization", avatar_url: "https://gh.com" },
      repository_selection: "all",
    }));
    // Page 2: 1 installation
    const page2Installations = [
      {
        id: 101,
        account: { login: "org-101", type: "Organization", avatar_url: "https://gh.com" },
        repository_selection: "all",
      },
    ];

    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 101, installations: page1Installations }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 101, installations: page2Installations }),
      });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = await res.json() as { installations: unknown[] };
    expect(body.installations).toHaveLength(101);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

// ── GET /connections/github/installations/:id/repositories ────────────────────

describe("GET /connections/github/installations/:id/repositories", () => {
  const INSTALL_ID = "12345";
  const PATH = `${BASE}/installations/${INSTALL_ID}/repositories`;

  it("returns 400 when connectionId is missing", async () => {
    const res = await authGet(PATH);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("connectionId");
  });

  it("returns 404 when connection is not found", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );
    const res = await authGet(`${PATH}?connectionId=con_MISSING`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when accessTokenEnc is null", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: null }]) as TxLike),
    );
    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(404);
  });

  it("returns 502 when GitHub API fails", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } }]) as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });

    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("403");
  });

  it("returns repositories with correct shape on happy path", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } }]) as TxLike),
    );

    const ghResponse = {
      total_count: 2,
      repositories: [
        {
          id: 9001,
          name: "my-api",
          full_name: "acme-org/my-api",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          description: "The main API",
        },
        {
          id: 9002,
          name: "internal-tools",
          full_name: "acme-org/internal-tools",
          private: true,
          default_branch: "main",
          language: null,
          description: null,
        },
      ],
    };
    mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ghResponse });

    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      repositories: Array<{
        id: number;
        name: string;
        fullName: string;
        private: boolean;
        defaultBranch: string;
        language: string | null;
        description: string | null;
      }>;
      totalCount: number;
    };

    expect(body.totalCount).toBe(2);
    expect(body.repositories).toHaveLength(2);
    expect(body.repositories[0]!.fullName).toBe("acme-org/my-api");
    expect(body.repositories[0]!.language).toBe("TypeScript");
    expect(body.repositories[1]!.private).toBe(true);
    expect(body.repositories[1]!.language).toBeNull();

    // Verify the request was made to the correct GitHub endpoint
    const fetchCall = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(fetchCall[0]).toContain(`/user/installations/${INSTALL_ID}/repositories`);
    expect(fetchCall[1]?.headers).toMatchObject({
      Authorization: "Bearer decrypted-access-token",
    });
  });
});
