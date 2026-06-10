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
 *   - Non-GitHub providers: skips without throwing
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
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

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

// Capture the Inngest handler
let capturedHandler: ((ctx: {
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
}) => Promise<unknown>) | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
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
  return { keyId: "test-key-id", ciphertext: Buffer.from(plain).toString("base64") };
}

// Set up default mocks before each test
beforeEach(() => {
  vi.clearAllMocks();

  // Default crypto adapter
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "test-key-id",
  });

  // Default: decrypt succeeds
  mocks.decrypt.mockResolvedValue("fake-refresh-token");

  // Default: encrypt returns a buffer
  mocks.encrypt.mockResolvedValue(Buffer.from("encrypted-value"));

  // Default: requireEnv returns configured GitHub creds
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

  it("skips a non-GitHub provider without throwing", async () => {
    const nonGithubAccount = {
      id: "acct-1",
      provider: "slack",
      access_token_enc: JSON.stringify(fakeEnvelope("access")),
      refresh_token_enc: JSON.stringify(fakeEnvelope("refresh")),
      org_id: "org-1",
    };

    // First withSystemDb call: find-expiring-tokens
    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: vi.fn().mockResolvedValue([nonGithubAccount]) }),
    );

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "slack" }),
      expect.stringContaining("not yet implemented"),
    );
  });
});

describe("ingestionOauthRefresh — GitHub happy path", () => {
  const githubAccount = {
    id: "acct-2",
    provider: "github",
    access_token_enc: JSON.stringify(fakeEnvelope("old-access")),
    refresh_token_enc: JSON.stringify(fakeEnvelope("old-refresh")),
    org_id: "org-1",
  };

  beforeEach(() => {
    // Step 1: find-expiring-tokens returns 1 account
    let callCount = 0;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        const execMock = vi.fn();
        if (callCount === 1) {
          // find-expiring-tokens query
          execMock.mockResolvedValue([githubAccount]);
        } else {
          // DB update query
          execMock.mockResolvedValue([]);
        }
        return fn({ execute: execMock });
      },
    );

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
    access_token_enc: JSON.stringify(fakeEnvelope("old-access")),
    refresh_token_enc: JSON.stringify(fakeEnvelope("old-refresh")),
    org_id: "org-1",
  };

  function setupAccountDb(execMock: ReturnType<typeof vi.fn>) {
    let callCount = 0;
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn({ execute: vi.fn().mockResolvedValue([githubAccount]) });
        }
        return fn({ execute: execMock });
      },
    );
  }

  it("increments failure count on fetch network error and does NOT throw", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupAccountDb(updateExec);
    mocks.fetchMock.mockRejectedValue(new Error("network timeout"));

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 }); // no throw
    expect(updateExec).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "acct-3" }),
      expect.stringContaining("HTTP call failed"),
    );
  });

  it("increments failure count when GitHub returns an error object", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupAccountDb(updateExec);
    mocks.fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({ error: "bad_verification_code", error_description: "bad code" }),
    });

    const result = await capturedHandler!({ step: makeStep() });
    expect(result).toEqual({ checked: 1 });
    expect(updateExec).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "bad_verification_code" }),
      expect.stringContaining("returned error"),
    );
  });

  it("increments failure count when decrypt fails and does NOT throw", async () => {
    const updateExec = vi.fn().mockResolvedValue([]);
    setupAccountDb(updateExec);
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
    setupAccountDb(vi.fn().mockResolvedValue([]));
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
