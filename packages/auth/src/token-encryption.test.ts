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

  it("returns all three encrypted fields WITHOUT plaintext (CONTRACT phase)", async () => {
    // OXA-1504: migration 0012 dropped plaintext access_token/refresh_token
    // columns. encryptAccountTokens must NOT return accessToken/refreshToken
    // in the result object (they must not be written back to the DB).
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
    // CONTRACT phase: plaintext must NOT be in the returned object.
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    // idToken is not a DB column; it is not in the return value.
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

  it("returns null token fields when tokenKmsKeyId is absent (pre-migration rows)", async () => {
    // CONTRACT phase: plaintext columns are gone. Pre-OXA-1420 rows have no
    // KMS key id and no encrypted columns — tokens are unavailable.
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

  it("create.before encrypts token fields and strips plaintext columns", async () => {
    // CONTRACT phase: access_token / refresh_token columns are dropped from DB.
    // The hook must NOT return accessToken / refreshToken in the data object.
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
    // Plaintext columns are absent — they were dropped in migration 0012.
    expect(result.data).not.toHaveProperty("accessToken");
    expect(result.data).not.toHaveProperty("refreshToken");
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
});
