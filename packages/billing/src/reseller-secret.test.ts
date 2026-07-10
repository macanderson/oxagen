import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptResellerSecret,
  decryptResellerSecret,
  secretLast4,
  RESELLER_KEY_ID,
} from "./reseller-secret";

// A valid base64-encoded 32-byte master key for the local AES-256-GCM adapter.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("reseller-secret", () => {
  const prevBilling = process.env["BILLING_ENCRYPTION_KEY"];
  const prevIngestion = process.env["INGESTION_ENCRYPTION_KEY"];

  beforeEach(() => {
    process.env["BILLING_ENCRYPTION_KEY"] = TEST_KEY;
    delete process.env["INGESTION_ENCRYPTION_KEY"];
  });
  afterEach(() => {
    if (prevBilling === undefined) delete process.env["BILLING_ENCRYPTION_KEY"];
    else process.env["BILLING_ENCRYPTION_KEY"] = prevBilling;
    if (prevIngestion === undefined)
      delete process.env["INGESTION_ENCRYPTION_KEY"];
    else process.env["INGESTION_ENCRYPTION_KEY"] = prevIngestion;
  });

  it("round-trips a secret through encrypt → decrypt", async () => {
    const secret = "sk_live_abcdef123456";
    const { ciphertext, keyId } = await encryptResellerSecret(secret);
    expect(keyId).toBe(RESELLER_KEY_ID);
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    // Ciphertext must not contain the plaintext.
    expect(ciphertext.toString("utf8")).not.toContain(secret);
    const decrypted = await decryptResellerSecret(ciphertext, keyId);
    expect(decrypted).toBe(secret);
  });

  it("produces different ciphertext each call (fresh DEK/IV) but the same plaintext", async () => {
    const secret = "sk_test_zzzz9999";
    const a = await encryptResellerSecret(secret);
    const b = await encryptResellerSecret(secret);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(await decryptResellerSecret(a.ciphertext, a.keyId)).toBe(secret);
    expect(await decryptResellerSecret(b.ciphertext, b.keyId)).toBe(secret);
  });

  it("falls back to INGESTION_ENCRYPTION_KEY when BILLING_ENCRYPTION_KEY is unset", async () => {
    delete process.env["BILLING_ENCRYPTION_KEY"];
    process.env["INGESTION_ENCRYPTION_KEY"] = TEST_KEY;
    const { ciphertext, keyId } = await encryptResellerSecret("sk_fallback");
    expect(await decryptResellerSecret(ciphertext, keyId)).toBe("sk_fallback");
  });

  it("throws when neither key env var is set", async () => {
    delete process.env["BILLING_ENCRYPTION_KEY"];
    delete process.env["INGESTION_ENCRYPTION_KEY"];
    await expect(encryptResellerSecret("x")).rejects.toThrow(
      /BILLING_ENCRYPTION_KEY/,
    );
  });

  it("rejects an unrecognized keyId on decrypt", async () => {
    const { ciphertext } = await encryptResellerSecret("sk_live_1");
    await expect(
      decryptResellerSecret(ciphertext, "billing:reseller:kms:v9"),
    ).rejects.toThrow(/unrecognized reseller key id/);
  });

  it("secretLast4 returns the last 4 chars, or the whole string when shorter", () => {
    expect(secretLast4("sk_live_abcd1234")).toBe("1234");
    expect(secretLast4("abc")).toBe("abc");
  });
});
