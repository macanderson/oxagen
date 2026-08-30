/**
 * resolve-connection-auth — turns a connection's stored credentials into an
 * in-memory AuthCredential for poll(). Mocks the DB, crypto, and the shared
 * OAuth refresh executor. Asserts credential precedence, inline refresh of an
 * expiring token, and the null (needs-reconnect) outcomes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  refreshOAuthToken: vi.fn(),
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
vi.mock("./oauth-strategies", () => ({
  refreshOAuthToken: mocks.refreshOAuthToken,
  isRefreshError: (r: unknown) =>
    typeof r === "object" && r !== null && "error" in r,
  PERMANENT_ERRORS: new Set(["invalid_grant", "revoked_token"]),
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn() },
}));

const { resolveConnectionAuth } = await import("./resolve-connection-auth");

const ENV = { keyId: "k", ciphertext: Buffer.from("x").toString("base64") };

/** Return each queued rows-array for successive withSystemDb calls. */
function queueDb(...results: unknown[][]) {
  const q = [...results];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: () => Promise.resolve(q.shift() ?? []) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
    adapter: {},
    keyId: "k",
  });
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "k",
  });
  mocks.encrypt.mockResolvedValue(Buffer.from("enc"));
});

describe("resolveConnectionAuth — oauth_accounts path", () => {
  it("returns a bearer token from a still-valid access token (no refresh)", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    queueDb(
      [{ delivery_config: { instanceUrl: "u" }, oauth_account_id: "acc1" }],
      [
        {
          access_token_enc: ENV,
          refresh_token_enc: null,
          expires_at: future,
          provider: "github",
        },
      ],
    );
    mocks.decrypt.mockResolvedValue("valid-access-token");

    const out = await resolveConnectionAuth("conn", "org");
    expect(out).toEqual({
      auth: { scheme: "bearer_token", token: "valid-access-token" },
      deliveryConfig: { instanceUrl: "u" },
    });
    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token inline and returns the new access token", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    queueDb(
      [{ delivery_config: {}, oauth_account_id: "acc1" }],
      [
        {
          access_token_enc: ENV,
          refresh_token_enc: ENV,
          expires_at: past,
          provider: "github",
        },
      ],
      [], // persist UPDATE
    );
    mocks.decrypt.mockResolvedValue("stored-refresh-token");
    mocks.refreshOAuthToken.mockResolvedValue({
      accessToken: "fresh-access",
      expiresInSec: 3600,
    });

    const out = await resolveConnectionAuth("conn", "org");
    expect(mocks.refreshOAuthToken).toHaveBeenCalledWith(
      "github",
      "stored-refresh-token",
    );
    expect(out?.auth).toEqual({
      scheme: "bearer_token",
      token: "fresh-access",
    });
    // The rotated token was persisted (encrypt called for the new access token).
    expect(mocks.encrypt).toHaveBeenCalled();
  });

  it("returns null when the refresh token is permanently revoked", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    queueDb(
      [{ delivery_config: {}, oauth_account_id: "acc1" }],
      [
        {
          access_token_enc: ENV,
          refresh_token_enc: ENV,
          expires_at: past,
          provider: "github",
        },
      ],
    );
    mocks.decrypt.mockResolvedValue("stored-refresh-token");
    mocks.refreshOAuthToken.mockResolvedValue({ error: "invalid_grant" });

    const out = await resolveConnectionAuth("conn", "org");
    expect(out).toBeNull();
  });

  it("falls back to the stored token on a transient refresh error", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    queueDb(
      [{ delivery_config: {}, oauth_account_id: "acc1" }],
      [
        {
          access_token_enc: ENV,
          refresh_token_enc: ENV,
          expires_at: past,
          provider: "github",
        },
      ],
    );
    // First decrypt = refresh token; second decrypt = the stale access token.
    mocks.decrypt
      .mockResolvedValueOnce("refresh-tok")
      .mockResolvedValueOnce("stale-access");
    mocks.refreshOAuthToken.mockResolvedValue({
      error: "temporarily_unavailable",
    });

    const out = await resolveConnectionAuth("conn", "org");
    expect(out?.auth).toEqual({
      scheme: "bearer_token",
      token: "stale-access",
    });
  });
});

describe("resolveConnectionAuth — auth_credentials path", () => {
  it("decrypts and parses a stored non-oauth credential", async () => {
    queueDb(
      [{ delivery_config: { host: "db" }, oauth_account_id: null }],
      [], // oauth_tokens empty
      [{ encrypted_payload: ENV }],
    );
    mocks.decrypt.mockResolvedValue(
      JSON.stringify({ scheme: "api_key", apiKey: "secret" }),
    );

    const out = await resolveConnectionAuth("conn", "org");
    expect(out).toEqual({
      auth: { scheme: "api_key", apiKey: "secret" },
      deliveryConfig: { host: "db" },
    });
  });
});

describe("resolveConnectionAuth — no credential", () => {
  it("returns null when the connection does not exist", async () => {
    queueDb([]);
    expect(await resolveConnectionAuth("conn", "org")).toBeNull();
  });

  it("returns null when no credential store has a row", async () => {
    queueDb([{ delivery_config: {}, oauth_account_id: null }], [], []);
    expect(await resolveConnectionAuth("conn", "org")).toBeNull();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn" }),
      expect.stringContaining("no usable credential"),
    );
  });
});
