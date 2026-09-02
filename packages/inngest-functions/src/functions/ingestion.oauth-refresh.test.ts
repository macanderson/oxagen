/**
 * ingestion.oauth-refresh Inngest function tests.
 *
 * Strategy: mock withSystemDb, createIngestionCryptoAdapter, decrypt, encrypt,
 * requireEnv, and the global fetch. Assert:
 *   - skips accounts where refresh_token_enc is null
 *   - GitHub: calls fetch with correct params, re-encrypts tokens, updates DB
 *   - GitHub: increments failure count on HTTP error (does NOT throw)
 *   - GitHub: increments failure count when GitHub returns an error object
 *   - GitHub: skips when GITHUB_APP_CLIENT_ID/SECRET not configured
 *   - Google: happy path (no refresh token rotation; expiresIn present)
 *   - Google: permanent error (invalid_grant) sets source_connection status='error'
 *   - Slack: happy path (ok:true response shape with rotated refresh token)
 *   - Slack: error (ok:false) increments failure count
 *   - Zoom: happy path (Basic-auth + rotated refresh token)
 *   - Zoom: permanent error (invalid_grant) sets source_connection status='error'
 *   - Salesforce: happy path (no refresh token rotation)
 *   - Microsoft: happy path (rotated refresh token)
 *   - Linear: skips without calling fetch (no-refresh provider)
 *   - Google family slugs (google-drive/google-gmail): normalize to the shared
 *     google strategy, refresh, and persist the new token
 *   - Unknown provider: skips without calling fetch, WARNs (visible silent-break)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  requireEnv: vi.fn(),
  fetchMock: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {},
}));

vi.mock("@oxagen/crypto", () => ({
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
}));

vi.mock("@oxagen/config", () => ({
  requireEnv: mocks.requireEnv,
}));

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.inngestCreateFunction,
}));

// Capture the Inngest handler
let capturedHandler:
  | ((ctx: {
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./ingestion.oauth-refresh");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// Helper: create a fake encrypted envelope
function fakeEnvelope(plain: string) {
  return {
    keyId: "test-key-id",
    ciphertext: Buffer.from(plain).toString("base64"),
  };
}

// Helper: set up withSystemDb so call 1 returns a single account and all
// subsequent calls (DB updates) succeed.
function setupSingleAccountDb(
  account: Record<string, unknown>,
  updateExec?: ReturnType<typeof vi.fn>,
) {
  let callCount = 0;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      const execMock =
        callCount === 1
          ? vi.fn().mockResolvedValue([account])
          : (updateExec ?? vi.fn().mockResolvedValue([]));
      return fn({ execute: execMock });
    },
  );
}

// Set up default mocks before each test
beforeEach(() => {
  vi.clearAllMocks();

  // Default crypto adapter (write/encrypt path)
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "test-key-id",
  });
  // Default crypto adapter (read/decrypt path)
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
    adapter: {},
    keyId: "test-key-id",
  });

  // Default: decrypt succeeds
  mocks.decrypt.mockResolvedValue("fake-refresh-token");

  // Default: encrypt returns a buffer
  mocks.encrypt.mockResolvedValue(Buffer.from("encrypted-value"));

  // Default: requireEnv returns configured GitHub creds (overridden per test)
  mocks.requireEnv.mockReturnValue({
    GITHUB_APP_CLIENT_ID: "gh-client-id",
    GITHUB_APP_CLIENT_SECRET: "gh-client-secret",
  });

  // Default: DB operations succeed
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: vi.fn().mockResolvedValue([]) }),
  );

  // Replace global fetch
  vi.stubGlobal("fetch", mocks.fetchMock);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — no-op cases", () => {
  it("returns checked=0 when no expiring tokens", async () => {
    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: vi.fn().mockResolvedValue([]),
        }),
    );

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 0 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("skips an unknown provider without throwing", async () => {
    const unknownAccount = {
      id: "acct-unknown",
      provider: "dropbox",
      access_token_enc: fakeEnvelope("access"),
      refresh_token_enc: fakeEnvelope("refresh"),
      org_id: "org-1",
    };

    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: vi.fn().mockResolvedValue([unknownAccount]) }),
    );

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    // A provider with expiring tokens and no strategy is surfaced at WARN so the
    // silent-break (token lapses, connection dies) is visible in logs.
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "dropbox" }),
      expect.stringContaining("no refresh strategy for provider"),
    );
  });
});

// ── Google Workspace family slugs (normalize to the shared google strategy) ────
//
// Every Google connector (google-drive, google-gmail, google-calendar, …) is
// backed by one Google OAuth grant. The stored oauth_accounts.provider may be
// the connector slug, so the cron must normalize `google-*` onto the `google`
// strategy — otherwise those tokens expire unrefreshed and the connection breaks.

describe("ingestionOauthRefresh — Google family slug normalization", () => {
  for (const slug of ["google-drive", "google-gmail"] as const) {
    it(`refreshes a ${slug} account via the shared Google strategy and persists the new token`, async () => {
      const account = {
        id: `acct-${slug}`,
        provider: slug,
        access_token_enc: fakeEnvelope("old-access"),
        refresh_token_enc: fakeEnvelope("old-refresh"),
        org_id: "org-1",
      };
      const updateExec = vi.fn().mockResolvedValue([]);
      setupSingleAccountDb(account, updateExec);
      mocks.requireEnv.mockReturnValue({
        GOOGLE_DATA_CLIENT_ID: "g-client-id",
        GOOGLE_DATA_CLIENT_SECRET: "g-client-secret",
      });
      mocks.fetchMock.mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          access_token: `new-${slug}-access`,
          expires_in: 3599,
        }),
      });

      const result = await capturedHandler!({ step: makeStep() });
      expect(result).toEqual({ checked: 1 });

      // Hits the Google token endpoint with grant_type=refresh_token.
      expect(mocks.fetchMock).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({ method: "POST" }),
      );
      const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(opts.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("g-client-id");

      // New access token is re-encrypted and persisted (DB update ran).
      expect(mocks.encrypt).toHaveBeenCalledWith(
        `new-${slug}-access`,
        "test-key-id",
        expect.anything(),
      );
      expect(updateExec).toHaveBeenCalled();
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ provider: slug }),
        expect.stringContaining("refreshed successfully"),
      );
    });
  }
});

// ── Linear (no-refresh provider) ────────────────────────────────────────────

describe("ingestionOauthRefresh — Linear (no-refresh provider)", () => {
  it("skips without calling fetch and logs a clear reason", async () => {
    const linearAccount = {
      id: "acct-linear",
      provider: "linear",
      access_token_enc: fakeEnvelope("access"),
      refresh_token_enc: fakeEnvelope("refresh"),
      org_id: "org-1",
    };

    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: vi.fn().mockResolvedValue([linearAccount]) }),
    );

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "linear" }),
      expect.stringContaining("does not support token refresh"),
    );
  });
});

// ── GitHub ────────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — GitHub happy path", () => {
  const githubAccount = {
    id: "acct-2",
    provider: "github",
    access_token_enc: fakeEnvelope("old-access"),
    refresh_token_enc: fakeEnvelope("old-refresh"),
    org_id: "org-1",
  };

  beforeEach(() => {
    setupSingleAccountDb(githubAccount);

    // Successful GitHub response
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
    });
  });

  it("calls GitHub token endpoint with correct params", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );

    const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("gh-client-id");
    expect(body.get("client_secret")).toBe("gh-client-secret");
    expect(body.get("refresh_token")).toBe("fake-refresh-token");
  });

  it("re-encrypts the new access token", async () => {
    await capturedHandler!({ step: makeStep() });
    expect(mocks.encrypt).toHaveBeenCalledWith(
      "new-access-token",
      "test-key-id",
      expect.anything(),
    );
  });

  it("re-encrypts the new refresh token when provided", async () => {
    await capturedHandler!({ step: makeStep() });
    expect(mocks.encrypt).toHaveBeenCalledWith(
      "new-refresh-token",
      "test-key-id",
      expect.anything(),
    );
  });

  it("returns checked=1", async () => {
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
  });

  it("logs success", async () => {
    await capturedHandler!({ step: makeStep() });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "acct-2", provider: "github" }),
      expect.stringContaining("refreshed successfully"),
    );
  });
});

describe("ingestionOauthRefresh — GitHub error handling", () => {
  const githubAccount = {
    id: "acct-3",
    provider: "github",
    access_token_enc: fakeEnvelope("old-access"),
    refresh_token_enc: fakeEnvelope("old-refresh"),
    org_id: "org-1",
  };

  it("increments failure count on fetch network error and does NOT throw", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(githubAccount, updateExec);
    mocks.fetchMock.mockRejectedValue(new Error("network timeout"));

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 }); // no throw
    expect(updateExec).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "acct-3" }),
      expect.stringContaining("HTTP call failed"),
    );
  });

  it("increments failure count when GitHub returns a transient error object", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(githubAccount, updateExec);
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        error: "bad_verification_code",
        error_description: "bad code",
      }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(updateExec).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "bad_verification_code" }),
      expect.stringContaining("incrementing failure count"),
    );
  });

  it("marks source_connection as error on permanent invalid_grant", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(githubAccount, updateExec);
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        error: "invalid_grant",
        error_description: "refresh token expired",
      }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    // Two DB writes: oauth_accounts failure count + source_connections status='error'
    expect(updateExec).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_grant", isPermanent: true }),
      expect.stringContaining("permanent error"),
    );
  });

  it("increments failure count when decrypt fails and does NOT throw", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(githubAccount, updateExec);
    mocks.decrypt.mockRejectedValue(new Error("key not found"));

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "acct-3" }),
      expect.stringContaining("failed to decrypt"),
    );
  });

  it("skips when GitHub App env vars are not configured", async () => {
    setupSingleAccountDb(githubAccount);
    mocks.requireEnv.mockImplementation(() => {
      throw new Error("Missing env: GITHUB_APP_CLIENT_ID");
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "acct-3" }),
      expect.stringContaining("not configured"),
    );
  });
});

// ── Google ────────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — Google happy path", () => {
  const googleAccount = {
    id: "acct-google",
    provider: "google",
    access_token_enc: fakeEnvelope("old-access"),
    refresh_token_enc: fakeEnvelope("old-refresh"),
    org_id: "org-1",
  };

  beforeEach(() => {
    setupSingleAccountDb(googleAccount);
    mocks.requireEnv.mockReturnValue({
      GOOGLE_DATA_CLIENT_ID: "g-client-id",
      GOOGLE_DATA_CLIENT_SECRET: "g-client-secret",
    });
    // Google does NOT rotate the refresh token — no refresh_token in the response
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        access_token: "new-google-access",
        expires_in: 3599,
      }),
    });
  });

  it("calls the Google token endpoint with correct params", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("g-client-id");
    expect(body.get("client_secret")).toBe("g-client-secret");
  });

  it("re-encrypts the new access token", async () => {
    await capturedHandler!({ step: makeStep() });
    expect(mocks.encrypt).toHaveBeenCalledWith(
      "new-google-access",
      "test-key-id",
      expect.anything(),
    );
  });

  it("does NOT encrypt a refresh token (Google does not rotate)", async () => {
    await capturedHandler!({ step: makeStep() });
    // encrypt should only be called once (access token only)
    const calls = mocks.encrypt.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.every(([val]) => val === "new-google-access")).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("returns checked=1 and logs success", async () => {
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google" }),
      expect.stringContaining("refreshed successfully"),
    );
  });
});

describe("ingestionOauthRefresh — Google permanent error", () => {
  it("marks source_connection as error on invalid_grant and does NOT throw", async () => {
    const googleAccount = {
      id: "acct-google-err",
      provider: "google",
      access_token_enc: fakeEnvelope("old-access"),
      refresh_token_enc: fakeEnvelope("old-refresh"),
      org_id: "org-1",
    };
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(googleAccount, updateExec);
    mocks.requireEnv.mockReturnValue({
      GOOGLE_DATA_CLIENT_ID: "g-client-id",
      GOOGLE_DATA_CLIENT_SECRET: "g-client-secret",
    });
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    // Two DB writes: failure count + source_connections status='error'
    expect(updateExec).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_grant", isPermanent: true }),
      expect.stringContaining("permanent error"),
    );
  });
});

// ── Slack ─────────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — Slack happy path", () => {
  const slackAccount = {
    id: "acct-slack",
    provider: "slack",
    access_token_enc: fakeEnvelope("old-access"),
    refresh_token_enc: fakeEnvelope("old-refresh"),
    org_id: "org-1",
  };

  beforeEach(() => {
    setupSingleAccountDb(slackAccount);
    mocks.requireEnv.mockReturnValue({
      SLACK_DATA_CLIENT_ID: "slack-client-id",
      SLACK_DATA_CLIENT_SECRET: "slack-client-secret",
    });
    // Slack returns ok:true with rotated access + refresh tokens
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        access_token: "new-slack-access",
        refresh_token: "new-slack-refresh",
        expires_in: 43200,
      }),
    });
  });

  it("calls the Slack token endpoint with correct params", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/oauth.v2.access",
      expect.objectContaining({ method: "POST" }),
    );
    const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("slack-client-id");
  });

  it("re-encrypts both access and refresh tokens on rotation", async () => {
    await capturedHandler!({ step: makeStep() });
    const encrypted = mocks.encrypt.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(encrypted).toContain("new-slack-access");
    expect(encrypted).toContain("new-slack-refresh");
  });

  it("returns checked=1 and logs success", async () => {
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "slack" }),
      expect.stringContaining("refreshed successfully"),
    );
  });
});

describe("ingestionOauthRefresh — Slack error (ok:false)", () => {
  it("increments failure count when Slack returns ok:false", async () => {
    const slackAccount = {
      id: "acct-slack-err",
      provider: "slack",
      access_token_enc: fakeEnvelope("old-access"),
      refresh_token_enc: fakeEnvelope("old-refresh"),
      org_id: "org-1",
    };
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(slackAccount, updateExec);
    mocks.requireEnv.mockReturnValue({
      SLACK_DATA_CLIENT_ID: "slack-client-id",
      SLACK_DATA_CLIENT_SECRET: "slack-client-secret",
    });
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({ ok: false, error: "invalid_auth" }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(updateExec).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_auth" }),
      expect.stringContaining("incrementing failure count"),
    );
  });
});

// ── Zoom ──────────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — Zoom happy path", () => {
  const zoomAccount = {
    id: "acct-zoom",
    provider: "zoom",
    access_token_enc: fakeEnvelope("old-access"),
    refresh_token_enc: fakeEnvelope("old-refresh"),
    org_id: "org-1",
  };

  beforeEach(() => {
    setupSingleAccountDb(zoomAccount);
    mocks.requireEnv.mockReturnValue({
      ZOOM_DATA_CLIENT_ID: "zoom-client-id",
      ZOOM_DATA_CLIENT_SECRET: "zoom-client-secret",
    });
    // Zoom rotates the refresh token
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        access_token: "new-zoom-access",
        refresh_token: "new-zoom-refresh",
        expires_in: 3600,
      }),
    });
  });

  it("calls the Zoom token endpoint with Basic auth header", async () => {
    await capturedHandler!({ step: makeStep() });

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://zoom.us/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
    const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    // Verify Basic auth header is present
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /);
    // Verify the body only contains grant_type + refresh_token (not client creds)
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("fake-refresh-token");
    expect(body.get("client_id")).toBeNull();
  });

  it("re-encrypts both tokens (Zoom always rotates refresh)", async () => {
    await capturedHandler!({ step: makeStep() });
    const encrypted = mocks.encrypt.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(encrypted).toContain("new-zoom-access");
    expect(encrypted).toContain("new-zoom-refresh");
  });

  it("returns checked=1", async () => {
    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
  });
});

describe("ingestionOauthRefresh — Zoom permanent error", () => {
  it("marks source_connection as error on invalid_grant", async () => {
    const zoomAccount = {
      id: "acct-zoom-err",
      provider: "zoom",
      access_token_enc: fakeEnvelope("old-access"),
      refresh_token_enc: fakeEnvelope("old-refresh"),
      org_id: "org-1",
    };
    const updateExec = vi.fn().mockResolvedValue([]);
    setupSingleAccountDb(zoomAccount, updateExec);
    mocks.requireEnv.mockReturnValue({
      ZOOM_DATA_CLIENT_ID: "zoom-client-id",
      ZOOM_DATA_CLIENT_SECRET: "zoom-client-secret",
    });
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({ reason: "invalid_grant" }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    // Two DB writes: failure count + source_connections status='error'
    expect(updateExec).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_grant", isPermanent: true }),
      expect.stringContaining("permanent error"),
    );
  });
});

// ── Salesforce ────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — Salesforce happy path", () => {
  it("calls the Salesforce token endpoint and re-encrypts only the access token", async () => {
    const sfAccount = {
      id: "acct-sf",
      provider: "salesforce",
      access_token_enc: fakeEnvelope("old-access"),
      refresh_token_enc: fakeEnvelope("old-refresh"),
      org_id: "org-1",
    };
    setupSingleAccountDb(sfAccount);
    mocks.requireEnv.mockReturnValue({
      SALESFORCE_DATA_CLIENT_ID: "sf-client-id",
      SALESFORCE_DATA_CLIENT_SECRET: "sf-client-secret",
    });
    // Salesforce does NOT rotate the refresh token
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        access_token: "new-sf-access",
        expires_in: 7200,
      }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://login.salesforce.com/services/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("sf-client-id");
    // Only one encrypt call — no refresh token rotation
    expect(mocks.encrypt).toHaveBeenCalledTimes(1);
    expect(mocks.encrypt).toHaveBeenCalledWith(
      "new-sf-access",
      "test-key-id",
      expect.anything(),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "salesforce" }),
      expect.stringContaining("refreshed successfully"),
    );
  });
});

// ── Microsoft ─────────────────────────────────────────────────────────────────

describe("ingestionOauthRefresh — Microsoft happy path", () => {
  it("calls the Microsoft token endpoint with scope and re-encrypts both tokens", async () => {
    const msAccount = {
      id: "acct-ms",
      provider: "microsoft",
      access_token_enc: fakeEnvelope("old-access"),
      refresh_token_enc: fakeEnvelope("old-refresh"),
      org_id: "org-1",
    };
    setupSingleAccountDb(msAccount);
    mocks.requireEnv.mockReturnValue({
      MICROSOFT_DATA_CLIENT_ID: "ms-client-id",
      MICROSOFT_DATA_CLIENT_SECRET: "ms-client-secret",
    });
    // Microsoft may rotate the refresh token (tenant policy-dependent)
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        access_token: "new-ms-access",
        refresh_token: "new-ms-refresh",
        expires_in: 3600,
      }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST" }),
    );
    const [, opts] = mocks.fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("scope")).toContain("offline_access");
    const encrypted = mocks.encrypt.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(encrypted).toContain("new-ms-access");
    expect(encrypted).toContain("new-ms-refresh");
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "microsoft" }),
      expect.stringContaining("refreshed successfully"),
    );
  });
});
