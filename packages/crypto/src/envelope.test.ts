/**
 * Unit tests for the envelope encryption module.
 *
 * The KMS adapter is mocked at the interface seam — no live AWS calls.
 * Tests cover:
 *   1. Round-trip: encrypt → decrypt returns the original plaintext.
 *   2. Tamper detection: mutating any ciphertext byte throws.
 *   3. Wrong-key failure: a different DEK causes AES-GCM tag verification
 *      to fail.
 *   4. Version gate: an unknown version byte throws.
 *   5. String input: plaintext strings are handled identically to Buffers.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "./envelope.js";
import type { KmsAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Mock KMS adapter — wraps the DEK with a trivial XOR of a fixed wrapping key
// so that decryption can recover the original DEK without any AWS calls.
// ---------------------------------------------------------------------------

function makeXorKmsAdapter(wrappingKey: Buffer): KmsAdapter {
  function xorBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) throw new Error("xorBuffers: length mismatch");
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
      // Non-null assertion safe: i is always within bounds.
      out[i] = (a[i] as number) ^ (b[i % b.length] as number);
    }
    return out;
  }

  return {
    async generateDataKey(_keyId: string) {
      const plaintext = randomBytes(32);
      // XOR with wrapping key — trivial "wrap"
      const encrypted = xorBuffers(plaintext, wrappingKey);
      return { plaintext, encrypted };
    },

    async decryptDataKey(encrypted: Uint8Array, _keyId: string) {
      return xorBuffers(encrypted, wrappingKey);
    },
  };
}

/** A second adapter that uses a different wrapping key — simulates a wrong KMS CMK. */
function makeWrongKeyAdapter(): KmsAdapter {
  return {
    async generateDataKey(_keyId: string) {
      // Never called in wrong-key test; present to satisfy the interface.
      return { plaintext: randomBytes(32), encrypted: randomBytes(32) };
    },

    async decryptDataKey(_encrypted: Uint8Array, _keyId: string) {
      // Returns a random DEK — wrong key, auth tag will fail.
      return randomBytes(32);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_KEY_ID = "arn:aws:kms:us-east-2:123456789012:key/test-fake-key-id";

function makeAdapter() {
  return makeXorKmsAdapter(randomBytes(32));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("envelope encryption", () => {
  it("round-trip: Buffer plaintext", async () => {
    const adapter = makeAdapter();
    const plaintext = Buffer.from("oauth-token-secret-abc123", "utf8");

    const ciphertext = await encrypt(plaintext, FAKE_KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, FAKE_KEY_ID, { adapter });

    expect(recovered.toString("utf8")).toBe("oauth-token-secret-abc123");
  });

  it("round-trip: string plaintext", async () => {
    const adapter = makeAdapter();
    const plaintext = "ya29.a0AfH6SMC_token_value";

    const ciphertext = await encrypt(plaintext, FAKE_KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, FAKE_KEY_ID, { adapter });

    expect(recovered.toString("utf8")).toBe(plaintext);
  });

  it("round-trip: empty plaintext", async () => {
    const adapter = makeAdapter();
    const ciphertext = await encrypt(Buffer.alloc(0), FAKE_KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, FAKE_KEY_ID, { adapter });
    expect(recovered.length).toBe(0);
  });

  it("round-trip: large plaintext (1 MiB)", async () => {
    const adapter = makeAdapter();
    const plaintext = randomBytes(1024 * 1024);
    const ciphertext = await encrypt(plaintext, FAKE_KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, FAKE_KEY_ID, { adapter });
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it("tamper detection: mutating a ciphertext byte throws", async () => {
    const adapter = makeAdapter();
    const ciphertext = await encrypt("sensitive-token", FAKE_KEY_ID, { adapter });

    // Flip a bit in the ciphertext payload (near the end, well past headers).
    const tampered = Buffer.from(ciphertext);
    const midpoint = Math.floor(tampered.length / 2);
    tampered[midpoint] = (tampered[midpoint] as number) ^ 0xff;

    await expect(decrypt(tampered, FAKE_KEY_ID, { adapter })).rejects.toThrow();
  });

  it("tamper detection: flipping the last byte (auth tag) throws", async () => {
    const adapter = makeAdapter();
    const ciphertext = await encrypt("another-token", FAKE_KEY_ID, { adapter });

    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x01;

    await expect(decrypt(tampered, FAKE_KEY_ID, { adapter })).rejects.toThrow();
  });

  it("wrong-key failure: returns wrong DEK → auth tag mismatch throws", async () => {
    const encryptAdapter = makeAdapter();
    const wrongKeyAdapter = makeWrongKeyAdapter();

    const ciphertext = await encrypt("token-to-protect", FAKE_KEY_ID, {
      adapter: encryptAdapter,
    });

    await expect(
      decrypt(ciphertext, FAKE_KEY_ID, { adapter: wrongKeyAdapter }),
    ).rejects.toThrow();
  });

  it("version gate: unknown version byte throws", async () => {
    const adapter = makeAdapter();
    const ciphertext = await encrypt("test", FAKE_KEY_ID, { adapter });

    // Overwrite the version byte with an unsupported value.
    const bad = Buffer.from(ciphertext);
    bad[0] = 0x99;

    await expect(decrypt(bad, FAKE_KEY_ID, { adapter })).rejects.toThrow(
      /Unsupported envelope version/,
    );
  });

  it("truncated ciphertext: throws a meaningful error", async () => {
    const adapter = makeAdapter();
    const truncated = Buffer.alloc(3); // Too short for any valid envelope.

    await expect(decrypt(truncated, FAKE_KEY_ID, { adapter })).rejects.toThrow(
      /too short/,
    );
  });

  it("each encrypt call produces a different ciphertext (fresh IV + DEK)", async () => {
    const adapter = makeAdapter();
    const ct1 = await encrypt("same-plaintext", FAKE_KEY_ID, { adapter });
    const ct2 = await encrypt("same-plaintext", FAKE_KEY_ID, { adapter });

    // Different IVs and DEKs mean the ciphertext bytes must differ.
    expect(ct1.equals(ct2)).toBe(false);
  });
});
