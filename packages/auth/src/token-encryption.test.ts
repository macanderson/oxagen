/**
 * Unit tests for token-encryption.ts.
 *
 * The @oxagen/crypto module is mocked so that tests run without real key
 * material — the encrypt/decrypt seam is exercised in crypto's own suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();

vi.mock("@oxagen/crypto", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args) as unknown,
  decrypt: (...args: unknown[]) => mockDecrypt(...args) as unknown,
}));

import {
  encryptAccountTokens,
  decryptAccountTokens,
  buildAccountTokenHooks,
  buildStripOnlyAccountHooks,
} from "./token-encryption";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_ID = "vercel-native-v1";

function makeMockAdapter() {
  return {} as Parameters<typeof encryptAccountTokens>[2];
}

// ---------------------------------------------------------------------------
// encryptToken (via encryptAccountTokens)
// ---------------------------------------------------------------------------

describe("encryptAccountTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null encrypted fields when input tokens are null", async () => {
    const adapter = makeMockAdapter();
    const result = await encryptAccountTokens(
      { accessToken: null, refreshToken: null, idToken: null },
      KEY_ID,
      adapter,
    );

    expect(result.accessTokenEnc).toBeNull();
    expect(result.refreshTokenEnc).toBeNull();
    expect(result.idTokenEnc).toBeNull();
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it("returns null encrypted fields when input tokens are empty string", async () => {
    const adapter = makeMockAdapter();
    const result = await encryptAccountTokens(
      { accessToken: "", refreshToken: "", idToken: "" },
      KEY_ID,
      adapter,
    );

    expect(result.accessTokenEnc).toBeNull();
    expect(result.refreshTokenEnc).toBeNull();
    expect(result.idTokenEnc).toBeNull();
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it("returns all three encrypted fields WITHOUT plaintext", async () => {
    // encryptAccountTokens must NOT return accessToken/refreshToken in the
    // result object — the caller strips plaintext separately, and this
    // function must never hand plaintext back for a write.
    const encBuf = Buffer.from("encrypted");
    mockEncrypt.mockResolvedValue(encBuf);

    const adapter = makeMockAdapter();
    const data = {
      accessToken: "acc_token",
      refreshToken: "ref_token",
      idToken: "id_token",
    };
    const result = await encryptAccountTokens(data, KEY_ID, adapter);

    // Encrypted columns present.
    expect(result.accessTokenEnc).toBe(encBuf);
    expect(result.refreshTokenEnc).toBe(encBuf);
    expect(result.idTokenEnc).toBe(encBuf);
    // KMS key id recorded.
    expect(result.tokenKmsKeyId).toBe(KEY_ID);
    // Plaintext must NOT be in the returned object.
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    expect(result.idToken).toBeUndefined();
    // encrypt called once per non-null token.
    expect(mockEncrypt).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// decryptAccountTokens
// ---------------------------------------------------------------------------

describe("decryptAccountTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null token fields when tokenKmsKeyId is absent (pre-encryption rows)", async () => {
    // Rows written before token encryption was enabled have no KMS key id and
    // no encrypted columns — the plaintext is not trusted, so tokens are
    // unavailable.
    const adapter = makeMockAdapter();
    const data = {
      accessTokenEnc: null,
      refreshTokenEnc: null,
      idTokenEnc: null,
    };
    const result = await decryptAccountTokens(data, adapter);

    expect(result.accessToken).toBeNull();
    expect(result.refreshToken).toBeNull();
    expect(result.idToken).toBeNull();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("decrypts _enc columns when tokenKmsKeyId is present", async () => {
    const encBuf = Buffer.from("enc_data");
    mockDecrypt.mockResolvedValue(Buffer.from("decrypted_value"));

    const adapter = makeMockAdapter();
    const data = {
      accessTokenEnc: encBuf,
      refreshTokenEnc: encBuf,
      idTokenEnc: encBuf,
      tokenKmsKeyId: KEY_ID,
    };
    const result = await decryptAccountTokens(data, adapter);

    // Decrypted values returned.
    expect(result.accessToken).toBe("decrypted_value");
    expect(result.refreshToken).toBe("decrypted_value");
    expect(result.idToken).toBe("decrypted_value");
    // decrypt called once per encrypted column.
    expect(mockDecrypt).toHaveBeenCalledTimes(3);
  });

  it("returns null tokens when _enc columns are null (partial row)", async () => {
    // Rows where encryption was attempted but tokens were not present at write time.
    const adapter = makeMockAdapter();
    const data = {
      accessTokenEnc: null,
      refreshTokenEnc: null,
      idTokenEnc: null,
      tokenKmsKeyId: KEY_ID,
    };
    const result = await decryptAccountTokens(data, adapter);

    expect(result.accessToken).toBeNull();
    expect(result.refreshToken).toBeNull();
    expect(result.idToken).toBeNull();
    // No encrypted data to decrypt.
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildAccountTokenHooks
// ---------------------------------------------------------------------------

describe("buildAccountTokenHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when the key-version label is empty", () => {
    const adapter = makeMockAdapter();
    expect(() => buildAccountTokenHooks(adapter, "")).toThrow(
      /key-version label is required/,
    );
  });

  it("returns create and update hooks when a key id is provided", () => {
    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);

    expect(hooks).toHaveProperty("create.before");
    expect(hooks).toHaveProperty("update.before");
    expect(typeof hooks.create.before).toBe("function");
    expect(typeof hooks.update.before).toBe("function");
  });

  it("create.before encrypts token fields and strips all plaintext columns", async () => {
    // The plaintext access_token / refresh_token / id_token columns still
    // exist in the schema, but this hook strips them on every write so no
    // plaintext is durably stored once the *_enc column is populated. The DB
    // trigger is the backstop for write paths that bypass this hook.
    const encBuf = Buffer.from("enc");
    mockEncrypt.mockResolvedValue(encBuf);

    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const result = await hooks.create.before({
      accessToken: "acc",
      refreshToken: "ref",
      idToken: "id",
    });

    // Encrypted columns are present.
    expect(result.data).toMatchObject({
      accessTokenEnc: encBuf,
      refreshTokenEnc: encBuf,
      idTokenEnc: encBuf,
      tokenKmsKeyId: KEY_ID,
    });
    // All three plaintext token fields are absent.
    expect(result.data).not.toHaveProperty("accessToken");
    expect(result.data).not.toHaveProperty("refreshToken");
    expect(result.data).not.toHaveProperty("idToken");
  });

  it("update.before skips encryption when no token field is present", async () => {
    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const account = { someOtherField: "value" };
    const result = await hooks.update.before(account);

    // Data returned unchanged; encrypt never called.
    expect(result.data).toBe(account);
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  // ── update.before: individual token fields encrypt and strip plaintext ────

  it("update.before with only accessToken → accessTokenEnc set, accessToken stripped", async () => {
    const encBuf = Buffer.from("enc_access");
    mockEncrypt.mockResolvedValue(encBuf);

    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const result = await hooks.update.before({
      accessToken: "ya29.access",
      userId: "u1",
    });

    expect(result.data.accessTokenEnc).toBe(encBuf);
    expect(result.data).not.toHaveProperty("accessToken");
    // refreshToken / idToken not in the update payload: their enc columns must
    // NOT be emitted at all (omitting them preserves the existing encrypted
    // values; emitting null would wipe a previously-stored refresh/id token).
    expect(result.data).not.toHaveProperty("refreshTokenEnc");
    expect(result.data).not.toHaveProperty("idTokenEnc");
    // Non-token field passes through
    expect(result.data.userId).toBe("u1");
  });

  it("update.before with only refreshToken → refreshTokenEnc set, refreshToken stripped", async () => {
    const encBuf = Buffer.from("enc_refresh");
    mockEncrypt.mockResolvedValue(encBuf);

    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const result = await hooks.update.before({
      refreshToken: "1//refresh.secret",
      userId: "u2",
    });

    expect(result.data.refreshTokenEnc).toBe(encBuf);
    expect(result.data).not.toHaveProperty("refreshToken");
    // Untouched token fields must not be emitted (preserve existing *_enc).
    expect(result.data).not.toHaveProperty("accessTokenEnc");
    expect(result.data).not.toHaveProperty("idTokenEnc");
  });

  it("update.before with only idToken → idTokenEnc set, idToken stripped", async () => {
    const encBuf = Buffer.from("enc_id");
    mockEncrypt.mockResolvedValue(encBuf);

    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const result = await hooks.update.before({
      idToken: "id.jwt.value",
      userId: "u3",
    });

    expect(result.data.idTokenEnc).toBe(encBuf);
    expect(result.data).not.toHaveProperty("idToken");
    // Untouched token fields must not be emitted (preserve existing *_enc).
    expect(result.data).not.toHaveProperty("accessTokenEnc");
    expect(result.data).not.toHaveProperty("refreshTokenEnc");
  });

  it("update.before with { accessToken: null } → key present but encryptToken(null) → accessTokenEnc: null, plaintext stripped", async () => {
    // encryptToken skips encryption for null/undefined and returns null;
    // the plaintext key must still be stripped from the output.
    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const result = await hooks.update.before({
      accessToken: null,
      userId: "u4",
    });

    // Key "accessToken" triggered the hasTokenField branch — encrypt was called
    // on null and returned null (no actual encrypt call).
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(result.data.accessTokenEnc).toBeNull();
    // plaintext must be stripped even when the value was null
    expect(result.data).not.toHaveProperty("accessToken");
    // Untouched token fields must not be emitted.
    expect(result.data).not.toHaveProperty("refreshTokenEnc");
    expect(result.data).not.toHaveProperty("idTokenEnc");
    // Non-token fields pass through
    expect(result.data.userId).toBe("u4");
  });

  it("update.before with accessToken only does NOT wipe a stored refresh_token (OAuth refresh flow)", async () => {
    // Regression: Google omits refresh_token on access-token refresh. The hook
    // must encrypt the new access token but leave refresh_token_enc / id_token_enc
    // untouched so the previously-stored encrypted refresh token survives.
    const encBuf = Buffer.from("enc_new_access");
    mockEncrypt.mockResolvedValue(encBuf);

    const adapter = makeMockAdapter();
    const hooks = buildAccountTokenHooks(adapter, KEY_ID);
    const result = await hooks.update.before({ accessToken: "ya29.refreshed" });

    expect(result.data.accessTokenEnc).toBe(encBuf);
    // The columns NOT in the payload must be absent from the write set, so the
    // existing encrypted refresh/id tokens in the DB are preserved.
    expect(result.data).not.toHaveProperty("refreshTokenEnc");
    expect(result.data).not.toHaveProperty("idTokenEnc");
    // KMS key id is still recorded for the touched column.
    expect(result.data.tokenKmsKeyId).toBe(KEY_ID);
    // Only the access token was encrypted.
    expect(mockEncrypt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildStripOnlyAccountHooks (no-encryption-key path, e.g. local dev)
// ---------------------------------------------------------------------------

describe("buildStripOnlyAccountHooks", () => {
  it("strips accessToken, refreshToken, and idToken on create (SOC2: no plaintext at rest)", async () => {
    // SOC2 hardening (migration 0009): idToken is now also stripped so that
    // plaintext is never durably stored. The DB trigger is the final backstop;
    // this hook is the application-layer first defence.
    const hooks = buildStripOnlyAccountHooks();
    const account = {
      providerId: "google",
      accountId: "g-123",
      userId: "u-1",
      accessToken: "ya29.secret",
      refreshToken: "1//refresh.secret",
      idToken: "id.jwt",
      scope: "openid email",
    };
    const { data } = await hooks.create.before(account);
    expect(data).not.toHaveProperty("accessToken");
    expect(data).not.toHaveProperty("refreshToken");
    // idToken is also stripped — no plaintext persisted once encrypted.
    expect(data).not.toHaveProperty("idToken");
    // Non-token fields pass through untouched.
    expect(data.providerId).toBe("google");
    expect(data.userId).toBe("u-1");
    expect(data.scope).toBe("openid email");
    // It never encrypts (no KMS adapter involved).
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it("strips accessToken, refreshToken, and idToken on update too", async () => {
    const hooks = buildStripOnlyAccountHooks();
    const { data } = await hooks.update.before({
      accessToken: "x",
      refreshToken: "y",
      idToken: "z",
      scope: "s",
    });
    expect(data).not.toHaveProperty("accessToken");
    expect(data).not.toHaveProperty("refreshToken");
    expect(data).not.toHaveProperty("idToken");
    expect(data.scope).toBe("s");
  });
});
