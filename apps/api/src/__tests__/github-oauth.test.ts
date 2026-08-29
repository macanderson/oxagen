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
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
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

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  // Partial mock: stub invoke/clearHandlersForTests but KEEP real exports such
  // as CapabilityError — error.ts does `err instanceof CapabilityError`, which
  // throws if the class is missing from the mock.
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    invoke: vi.fn(),
    clearHandlersForTests: vi.fn(),
  };
});

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
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
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

// The github_installations registry upsert has its own dedicated suite
// (github-installations.test.ts). Stub it to a no-op so the callback logic tests
// aren't perturbed by its extra withSystemDb call in the resolution sequence.
// MUST resolve a promise — the callback chains `.catch()` on the result.
vi.mock("../routes/v1/github-installations", () => ({
  upsertGithubInstallation: vi.fn().mockResolvedValue(undefined),
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

const APP_SLUG = "oxagen-test";

const DEFAULT_ENV = {
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  GITHUB_APP_INSTALL_STATE_SECRET: STATE_SECRET,
  GITHUB_APP_SLUG: APP_SLUG,
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
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.innerJoin.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  selectChain.orderBy.mockReturnValue(selectChain);

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
    connectionId: string | null;
    returnTo: "settings" | "sources";
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
  const hmac = createHmac("sha256", STATE_SECRET)
    .update(stateJson)
    .digest("hex");
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
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
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
  it("works WITHOUT a connectionId (settings-level connect) and encodes a null connectionId", async () => {
    // The install lives in workspace settings (1 workspace = 1 app install),
    // so auth-url does not require a pre-created source_connection.
    const res = await authGet(`${BASE}/auth-url?returnTo=settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string };
    expect(body.authUrl).toContain(
      `github.com/apps/${APP_SLUG}/installations/new`,
    );

    const stateParam = new URL(body.authUrl).searchParams.get("state")!;
    const encoded = stateParam.slice(0, stateParam.lastIndexOf("."));
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { connectionId: string | null; returnTo: string };
    expect(payload.connectionId).toBeNull();
    expect(payload.returnTo).toBe("settings");
  });

  it("returns 503 when GITHUB_APP_SLUG is missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
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

  it("returns the GitHub App installations/new URL with the app slug + state", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string };
    // Install flow (not bare OAuth authorize) so a first-time user installs the
    // App AND GitHub round-trips our signed state back to the callback.
    expect(body.authUrl).toContain(
      `github.com/apps/${APP_SLUG}/installations/new`,
    );
    expect(body.authUrl).not.toContain("login/oauth/authorize");
    expect(body.authUrl).toContain("state=");
  });

  it("does NOT pass redirect_uri (the App's configured Callback URL is used)", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    const body = (await res.json()) as { authUrl: string };
    expect(body.authUrl).not.toContain("redirect_uri");
  });

  it("state encodes the connectionId + orgId + workspaceId as base64url JSON", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_MYCONN`);
    const body = (await res.json()) as { authUrl: string };
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
    const expectedHmac = createHmac("sha256", STATE_SECRET)
      .update(stateJson)
      .digest("hex");
    expect(receivedHmac).toBe(expectedHmac);
  });

  it("expiresAt is ~10 minutes in the future", async () => {
    const before = Date.now();
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    const after = Date.now();
    const body = (await res.json()) as { authUrl: string };

    const rawState = decodeURIComponent(
      body.authUrl.match(/[?&]state=([^&]+)/)![1]!,
    );
    const dotIdx = rawState.lastIndexOf(".");
    const stateJson = Buffer.from(
      rawState.slice(0, dotIdx),
      "base64url",
    ).toString("utf8");
    const { expiresAt } = JSON.parse(stateJson) as { expiresAt: number };

    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 100);
  });
});

// ── GET /connections/github/status ────────────────────────────────────────────

describe("GET /connections/github/status", () => {
  it("returns 503 when the GitHub App is not configured", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(503);
  });

  it("reports not-connected (with an install URL) when the org has no GitHub OAuth account", async () => {
    // Default DB returns no oauth_accounts row → not connected, but the settings
    // UI still needs a connect URL.
    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      installations: unknown[];
      installUrl: string;
    };
    expect(body.connected).toBe(false);
    expect(body.installations).toHaveLength(0);
    expect(body.installUrl).toContain(
      `github.com/apps/${APP_SLUG}/installations/new`,
    );
  });

  it("reports connected with the installations the token can reach", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          {
            id: "oa1",
            accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" },
          },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [
          {
            id: 444,
            account: {
              login: "connected-org",
              type: "Organization",
              avatar_url: "https://gh.com/444",
            },
            repository_selection: "selected",
            html_url:
              "https://github.com/organizations/connected-org/settings/installations/444",
          },
        ],
      }),
    });

    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      installations: Array<{ accountLogin: string; htmlUrl: string | null }>;
      manageUrl: string;
      installUrl: string;
    };
    expect(body.connected).toBe(true);
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]!.accountLogin).toBe("connected-org");
    expect(body.installUrl).toContain("installations/new");
  });

  it("reports not-connected when the user token has been revoked (GitHub 401)", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          {
            id: "oa1",
            accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" },
          },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
  });
});

// ── GET /oauth/github/callback ────────────────────────────────────────────────

describe("GET /oauth/github/callback", () => {
  function makeCallbackReq(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return app.fetch(makeRequest(`${CALLBACK_PATH}?${qs}`));
  }

  it("code is optional: a valid-state install with no code still completes (no token exchange)", async () => {
    // With "user authorization during installation" off, the install redirect
    // carries installation_id + setup_action + state but no code. The callback
    // must still record the install and redirect, not 400.
    // withSystemDb order (no code): conn lookup, UPDATE, org slug, ws slug.
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-org" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-ws" }]) as TxLike),
      );

    const res = await makeCallbackReq({
      state: buildValidState(),
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/knowledge/sources");
    // No code → no token exchange / encryption.
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("returns 400 when state is missing and there are no install params", async () => {
    const res = await makeCallbackReq({ code: "test-code" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing");
  });

  it("redirects (not 400) for a GitHub-initiated install that has no signed state", async () => {
    // User installs the App straight from GitHub's app page → installation_id +
    // setup_action but no state. Must redirect into the app, not 400.
    const res = await makeCallbackReq({
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("github_installed=1");
  });

  it("returns 503 when GitHub App env vars are missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_CLIENT_ID: undefined,
    });
    const res = await makeCallbackReq({
      code: "code",
      state: buildValidState(),
    });
    expect(res.status).toBe(503);
  });

  it("returns 400 when state format is invalid (no dot separator)", async () => {
    const res = await makeCallbackReq({
      code: "code",
      state: "nodotseparator",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid state format");
  });

  it("returns 400 when state base64url decoding fails", async () => {
    const res = await makeCallbackReq({
      code: "code",
      state: "!!!invalid_base64!!!.abc123",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when state HMAC does not match", async () => {
    const validState = buildValidState();
    const dotIdx = validState.lastIndexOf(".");
    const tampered = `${validState.slice(0, dotIdx)}.deadbeefdeadbeef`;
    const res = await makeCallbackReq({ code: "code", state: tampered });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("signature");
  });

  it("returns 400 when state is expired", async () => {
    const expiredState = buildValidState({ expiresAt: Date.now() - 1000 });
    const res = await makeCallbackReq({ code: "code", state: expiredState });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("expired");
  });

  it("returns 502 when GitHub token exchange API returns non-200", async () => {
    // Connection lookup runs first now, so it must find the row for the flow to
    // reach token exchange.
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const res = await makeCallbackReq({
      code: "code",
      state: buildValidState(),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("503");
  });

  it("returns 400 when GitHub token exchange returns error field", async () => {
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        error: "bad_verification_code",
        error_description: "Code already used",
      }),
    });

    const res = await makeCallbackReq({
      code: "code",
      state: buildValidState(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
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
        json: async () => ({
          id: 12345,
          login: "testuser",
          email: "test@test.com",
          name: "Test User",
        }),
      });

    // DB: source_connection found
    const connRow = {
      id: "uuid-conn-1",
      orgId: "org-id-test",
      workspaceId: "ws-id-test",
    };
    // oauthAccounts insert
    const oauthRow = { id: "uuid-oauth-1" };
    // orgs slug
    const orgSlugRow = { slug: "my-org" };
    // workspaces slug
    const wsSlugRow = { slug: "my-ws" };

    // withSystemDb calls in order: source_connections lookup, oauth upsert, oauth update, org slug, ws slug
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([connRow]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([oauthRow]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      ) // UPDATE source_connections
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([orgSlugRow]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([wsSlugRow]) as TxLike),
      );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
    });

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
    // Connection lookup runs FIRST now, so an empty result 404s before any token
    // exchange — no fetch should occur.
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
    });
    expect(res.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("settings connect (null connectionId): stores the org token and redirects to settings/github", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_settings",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      });

    // No connection lookup (connectionId is null). withSystemDb order:
    // oauth upsert, org slug, ws slug. There is NO connection UPDATE.
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "oauth-settings" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-org" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-ws" }]) as TxLike),
      );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/my-org/my-ws/settings/github");
    expect(location).toContain("github_connected=1");
    expect(location).not.toContain("connectionId");
    // Token was stored even though no connection was attached.
    expect(mocks.encrypt).toHaveBeenCalled();
  });

  it("merges the installation_id into deliveryConfig without clobbering existing keys", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_x",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 99, login: "u" }),
      });

    // Capture the UPDATE .set() payload to assert the merge.
    let updateSetArg: Record<string, unknown> | undefined;
    const updateChain = {
      set: vi.fn((arg: Record<string, unknown>) => {
        updateSetArg = arg;
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const updateTx = {
      ...makeTxChain([]),
      update: vi.fn().mockReturnValue(updateChain),
    };

    // Order: conn lookup (has existing config), oauth upsert, UPDATE (captured), org slug, ws slug.
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(
          makeTxChain([
            { id: "uuid-conn-1", deliveryConfig: { syncDepthDays: 90 } },
          ]) as TxLike,
        ),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "oauth-1" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(updateTx as unknown as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "o" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "w" }]) as TxLike),
      );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(updateSetArg?.deliveryConfig).toEqual({
      syncDepthDays: 90,
      installationId: "142003699",
    });
    expect(updateSetArg?.oauthAccountId).toBe("oauth-1");
  });
});

// ── GET /connections/github/installations ─────────────────────────────────────

describe("GET /connections/github/installations", () => {
  it("WITHOUT a connectionId, resolves the workspace token (404 when the org has no GitHub OAuth account)", async () => {
    // Settings + post-install sources picker omit connectionId; the resolver
    // falls back to the org's GitHub OAuth account, which is absent here.
    const res = await authGet(`${BASE}/installations`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not connected");
  });

  it("WITHOUT a connectionId, lists installations using the workspace's org GitHub token", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          {
            id: "oa1",
            accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" },
          },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [
          {
            id: 333,
            account: {
              login: "ws-org",
              type: "Organization",
              avatar_url: "https://gh.com/333",
            },
            repository_selection: "all",
          },
        ],
      }),
    });

    const res = await authGet(`${BASE}/installations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<{ accountLogin: string }>;
    };
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]!.accountLogin).toBe("ws-org");
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
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("token not found");
  });

  it("returns 502 when GitHub API fails", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("401");
  });

  it("returns installations list on happy path", async () => {
    // Unset GITHUB_APP_SLUG so manageUrl derives from the installation's app_slug.
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );

    const ghResponse = {
      total_count: 2,
      installations: [
        {
          id: 111,
          account: {
            login: "acme-org",
            type: "Organization",
            avatar_url: "https://avatars.gh.com/111",
          },
          repository_selection: "all",
          html_url:
            "https://github.com/organizations/acme-org/settings/installations/111",
          app_slug: "oxagen",
        },
        {
          id: 222,
          account: {
            login: "bob",
            type: "User",
            avatar_url: "https://avatars.gh.com/222",
          },
          repository_selection: "selected",
        },
      ],
    };
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ghResponse,
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      installations: Array<{
        id: number;
        accountLogin: string;
        accountType: string;
        repositorySelection: string;
        avatarUrl: string;
        htmlUrl: string | null;
      }>;
      manageUrl: string;
    };
    expect(body.installations).toHaveLength(2);
    expect(body.installations[0]!.accountLogin).toBe("acme-org");
    expect(body.installations[0]!.accountType).toBe("Organization");
    expect(body.installations[0]!.repositorySelection).toBe("all");
    // Per-installation management page is mapped through; null when GitHub omits it.
    expect(body.installations[0]!.htmlUrl).toBe(
      "https://github.com/organizations/acme-org/settings/installations/111",
    );
    expect(body.installations[1]!.id).toBe(222);
    expect(body.installations[1]!.htmlUrl).toBeNull();
    // manageUrl derives from the installation's app_slug when GITHUB_APP_SLUG is unset.
    expect(body.manageUrl).toBe(
      "https://github.com/apps/oxagen/installations/new",
    );
  });

  it("manageUrl uses GITHUB_APP_SLUG when configured", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: "oxagen-prod",
    });
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [
          {
            id: 111,
            account: {
              login: "acme-org",
              type: "Organization",
              avatar_url: "https://gh.com",
            },
            repository_selection: "all",
            app_slug: "from-installation",
          },
        ],
      }),
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manageUrl: string };
    // Configured slug wins over the installation-derived slug.
    expect(body.manageUrl).toBe(
      "https://github.com/apps/oxagen-prod/installations/new",
    );
  });

  it("manageUrl falls back to GitHub settings when no slug is available", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    // Zero installations and no GITHUB_APP_SLUG → generic settings page.
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, installations: [] }),
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manageUrl: string;
      installations: unknown[];
    };
    expect(body.installations).toHaveLength(0);
    expect(body.manageUrl).toBe("https://github.com/settings/installations");
  });

  it("paginates when total_count exceeds 100", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );

    // Page 1: 100 installations
    const page1Installations = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: {
        login: `org-${i + 1}`,
        type: "Organization",
        avatar_url: "https://gh.com",
      },
      repository_selection: "all",
    }));
    // Page 2: 1 installation
    const page2Installations = [
      {
        id: 101,
        account: {
          login: "org-101",
          type: "Organization",
          avatar_url: "https://gh.com",
        },
        repository_selection: "all",
      },
    ];

    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 101,
          installations: page1Installations,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 101,
          installations: page2Installations,
        }),
      });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toHaveLength(101);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

// ── GET /connections/github/installations/:id/repositories ────────────────────

describe("GET /connections/github/installations/:id/repositories", () => {
  const INSTALL_ID = "12345";
  const PATH = `${BASE}/installations/${INSTALL_ID}/repositories`;

  it("WITHOUT a connectionId, resolves the workspace token (404 when the org has no GitHub OAuth account)", async () => {
    // connectionId is now optional here too — the post-install sources picker
    // lists repos using the workspace's org-level token.
    const res = await authGet(PATH);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not connected");
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
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
    });

    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("403");
  });

  it("returns repositories with correct shape on happy path", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
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
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ghResponse,
    });

    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
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
    expect(fetchCall[0]).toContain(
      `/user/installations/${INSTALL_ID}/repositories`,
    );
    expect(fetchCall[1]?.headers).toMatchObject({
      Authorization: "Bearer decrypted-access-token",
    });
  });
});

// ── OAuth token resolution (Setup-URL "update" leg) ───────────────────────────
//
// When the GitHub App is ALREADY installed, GitHub completes the connect through
// the stateless Setup URL leg, which never hits our OAuth callback — so the
// freshly-created connection has a null oauthAccountId. The endpoints must fall
// back to the org's existing GitHub OAuth account (and link it) rather than 404,
// which is what dead-ended the wizard at "list installations".

describe("OAuth token resolution for /installations", () => {
  const ENC = { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" };

  /**
   * A tx whose successive .select()…​.limit() calls resolve successive queued
   * result sets, and whose .update().set() payload is captured. Supports the
   * .orderBy() used by the fallback query (the shared makeTxChain does not).
   */
  function makeSequencedTx(
    selectResults: unknown[][],
    onUpdateSet?: (arg: Record<string, unknown>) => void,
  ) {
    let call = 0;
    const makeSelectChain = () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(async () => selectResults[call++] ?? []);
      return chain;
    };
    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn((arg: Record<string, unknown>) => {
      onUpdateSet?.(arg);
      return updateChain;
    });
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    return {
      select: vi.fn(() => makeSelectChain()),
      update: vi.fn(() => updateChain),
      insert: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
  }

  const GH_OK = {
    ok: true,
    status: 200,
    json: async () => ({
      total_count: 1,
      installations: [
        {
          id: 111,
          account: {
            login: "acme",
            type: "Organization",
            avatar_url: "https://gh.com",
          },
          repository_selection: "all",
        },
      ],
    }),
  };

  it("falls back to and links the org's GitHub OAuth account when the connection is unlinked", async () => {
    let updateArg: Record<string, unknown> | undefined;
    // Query order inside resolveConnectionAccessToken:
    //   1. source_connections → { id, oauthAccountId: null }  (unlinked)
    //   2. oauth_accounts fallback → { id, accessTokenEnc }    (the org's account)
    const seqTx = makeSequencedTx(
      [
        [{ id: "conn-uuid-1", oauthAccountId: null }],
        [{ id: "oa-org-1", accessTokenEnc: ENC }],
      ],
      (arg) => {
        updateArg = arg;
      },
    );
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(seqTx as unknown as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce(GH_OK);

    const res = await authGet(
      `${BASE}/installations?connectionId=con_UPDATE_LEG`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toHaveLength(1);

    // The unlinked connection is now linked to the fallback account so the
    // activation path and later calls resolve it directly.
    expect(updateArg?.oauthAccountId).toBe("oa-org-1");
    // The fetch used the decrypted fallback token.
    const fetchCall = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(fetchCall[1]?.headers).toMatchObject({
      Authorization: "Bearer decrypted-access-token",
    });
  });

  it("uses the directly-linked OAuth account without a fallback when one is set", async () => {
    let updateCalled = false;
    // Query order: source_connections → { oauthAccountId set }, then
    // oauth_accounts BY ID → { accessTokenEnc }. No fallback select, no update.
    const seqTx = makeSequencedTx(
      [
        [{ id: "conn-uuid-2", oauthAccountId: "oa-linked-1" }],
        [{ accessTokenEnc: ENC }],
      ],
      () => {
        updateCalled = true;
      },
    );
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(seqTx as unknown as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce(GH_OK);

    const res = await authGet(`${BASE}/installations?connectionId=con_LINKED`);
    expect(res.status).toBe(200);
    // A connection already linked must not be re-linked.
    expect(updateCalled).toBe(false);
  });

  it("returns 404 when neither the connection nor the org has any GitHub OAuth account", async () => {
    // source_connections → unlinked; fallback oauth_accounts → empty.
    const seqTx = makeSequencedTx([
      [{ id: "conn-uuid-3", oauthAccountId: null }],
      [],
    ]);
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(seqTx as unknown as TxLike),
    );

    const res = await authGet(`${BASE}/installations?connectionId=con_NOAUTH`);
    expect(res.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
