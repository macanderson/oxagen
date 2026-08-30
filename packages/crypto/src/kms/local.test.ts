/**
 * Tests for the local KEK adapter — exercises it through the real envelope
 * encrypt/decrypt path (no mocks at the crypto seam) so we validate the
 * adapter the same way production uses it.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../envelope";
import { createLocalKmsAdapter, loadMasterKey } from "./local";

const KEY_ID = "vercel-native-v1";

describe("createLocalKmsAdapter", () => {
  it("round-trips a token through envelope encryption", async () => {
    const adapter = createLocalKmsAdapter(randomBytes(32));
    const plaintext = "ya29.a0Af-some-oauth-access-token";

    const ciphertext = await encrypt(plaintext, KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, KEY_ID, { adapter });

    expect(recovered.toString("utf8")).toBe(plaintext);
    // The plaintext must not appear in the encrypted output.
    expect(ciphertext.includes(Buffer.from(plaintext, "utf8"))).toBe(false);
  });

  it("produces distinct ciphertexts for the same plaintext (fresh DEK + IV)", async () => {
    const adapter = createLocalKmsAdapter(randomBytes(32));
    const a = await encrypt("same-input", KEY_ID, { adapter });
    const b = await encrypt("same-input", KEY_ID, { adapter });
    expect(a.equals(b)).toBe(false);
  });

  it("round-trips empty input", async () => {
    const adapter = createLocalKmsAdapter(randomBytes(32));
    const ciphertext = await encrypt(Buffer.alloc(0), KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, KEY_ID, { adapter });
    expect(recovered.length).toBe(0);
  });

  it("fails to decrypt with a different master key", async () => {
    const writer = createLocalKmsAdapter(randomBytes(32));
    const wrongReader = createLocalKmsAdapter(randomBytes(32));
    const ciphertext = await encrypt("secret", KEY_ID, { adapter: writer });

    await expect(
      decrypt(ciphertext, KEY_ID, { adapter: wrongReader }),
    ).rejects.toThrow();
  });

  it("fails to decrypt a tampered ciphertext (GCM auth tag)", async () => {
    const adapter = createLocalKmsAdapter(randomBytes(32));
    const ciphertext = await encrypt("secret", KEY_ID, { adapter });
    // Flip a byte in the final ciphertext segment.
    const idx = ciphertext.length - 1;
    ciphertext.writeUInt8((ciphertext.readUInt8(idx) ^ 0xff) & 0xff, idx);
    await expect(decrypt(ciphertext, KEY_ID, { adapter })).rejects.toThrow();
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => createLocalKmsAdapter(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("decryptDataKey: rejects a wrapped key buffer with unexpected length", async () => {
    const adapter = createLocalKmsAdapter(randomBytes(32));
    // WRAPPED_LEN = IV(12) + TAG(16) + DEK(32) = 60; pass a 10-byte buffer instead.
    const wrongLength = randomBytes(10);
    await expect(adapter.decryptDataKey(wrongLength, KEY_ID)).rejects.toThrow(
      /unexpected length/,
    );
  });
});

describe("loadMasterKey", () => {
  it("decodes a valid base64 32-byte key", () => {
    const b64 = randomBytes(32).toString("base64");
    expect(loadMasterKey(b64).length).toBe(32);
  });

  it("throws with a generation hint on the wrong length", () => {
    const b64 = randomBytes(16).toString("base64");
    expect(() => loadMasterKey(b64)).toThrow(/openssl rand -base64 32/);
  });
});
