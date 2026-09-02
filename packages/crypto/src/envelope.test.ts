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
import { encrypt, decrypt } from "./envelope";
import type { KmsAdapter } from "./types";

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
    const ciphertext = await encrypt("sensitive-token", FAKE_KEY_ID, {
      adapter,
    });

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
    tampered[tampered.length - 1] =
      (tampered[tampered.length - 1] as number) ^ 0x01;

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

  it("invalid DEK length on generateDataKey: encrypt throws /Expected 32-byte DEK/", async () => {
    const badGenerateAdapter: KmsAdapter = {
      async generateDataKey(_keyId: string) {
        const plaintext = randomBytes(16); // Wrong length — should be 32.
        return { plaintext, encrypted: randomBytes(16) };
      },
      async decryptDataKey(_encrypted: Uint8Array, _keyId: string) {
        return randomBytes(32);
      },
    };

    await expect(
      encrypt("some-plaintext", FAKE_KEY_ID, { adapter: badGenerateAdapter }),
    ).rejects.toThrow(/Expected 32-byte DEK/);
  });

  it("invalid DEK length on decryptDataKey: decrypt throws /Expected 32-byte DEK/", async () => {
    const encryptAdapter = makeAdapter();
    const ciphertext = await encrypt("some-plaintext", FAKE_KEY_ID, {
      adapter: encryptAdapter,
    });

    const badDecryptAdapter: KmsAdapter = {
      async generateDataKey(_keyId: string) {
        return { plaintext: randomBytes(32), encrypted: randomBytes(32) };
      },
      async decryptDataKey(_encrypted: Uint8Array, _keyId: string) {
        return randomBytes(16); // Wrong length — should be 32.
      },
    };

    await expect(
      decrypt(ciphertext, FAKE_KEY_ID, { adapter: badDecryptAdapter }),
    ).rejects.toThrow(/Expected 32-byte DEK/);
  });

  it("mid-parse truncation: header fields exceed remaining buffer → throws /truncated/", async () => {
    // Build a buffer that passes the minimum header-length check (>= 9 bytes)
    // but whose declared length fields sum to more bytes than are present.
    const buf = Buffer.allocUnsafe(9 + 4); // 9-byte header + 4 payload bytes
    let offset = 0;
    buf.writeUInt8(0x01, offset);
    offset += 1; // version
    buf.writeUInt16BE(12, offset);
    offset += 2; // iv_len = 12
    buf.writeUInt16BE(32, offset);
    offset += 2; // enc_dek_len = 32
    buf.writeUInt32BE(100, offset); // ct_len = 100 (far exceeds remaining 4 bytes)

    await expect(
      decrypt(buf, FAKE_KEY_ID, { adapter: makeAdapter() }),
    ).rejects.toThrow(/truncated/);
  });

  it("ct+tag segment shorter than AES-GCM tag size: decrypt throws", async () => {
    // Build a syntactically valid envelope where ctLen=5 (< 16 = AES_GCM_TAG_BYTES).
    // ivLen=12, encDekLen=32, ctLen=5 → total 9+12+32+5=58 bytes (passes truncation check).
    const ctLen = 5;
    const ivLen = 12;
    const encDekLen = 32;
    const buf = Buffer.alloc(9 + ivLen + encDekLen + ctLen, 0);
    let off = 0;
    buf.writeUInt8(0x01, off);
    off += 1;
    buf.writeUInt16BE(ivLen, off);
    off += 2;
    buf.writeUInt16BE(encDekLen, off);
    off += 2;
    buf.writeUInt32BE(ctLen, off);

    await expect(
      decrypt(buf, FAKE_KEY_ID, { adapter: makeAdapter() }),
    ).rejects.toThrow(/too short.*auth tag/i);
  });

  it("each encrypt call produces a different ciphertext (fresh IV + DEK)", async () => {
    const adapter = makeAdapter();
    const ct1 = await encrypt("same-plaintext", FAKE_KEY_ID, { adapter });
    const ct2 = await encrypt("same-plaintext", FAKE_KEY_ID, { adapter });

    // Different IVs and DEKs mean the ciphertext bytes must differ.
    expect(ct1.equals(ct2)).toBe(false);
  });

  it("wire-format: raw buffer fields match the documented layout", async () => {
    // Verify that the binary layout produced by encrypt() matches the spec:
    // [1 version][2 iv_len][2 enc_dek_len][4 ct_len][iv_len iv][enc_dek_len enc_dek][ct_len ct+tag]
    const adapter = makeAdapter();
    const plaintext = Buffer.from("wire-format-test", "utf8");
    const ct = await encrypt(plaintext, FAKE_KEY_ID, { adapter });

    let offset = 0;

    const version = ct.readUInt8(offset);
    offset += 1;
    expect(version).toBe(0x01);

    const ivLen = ct.readUInt16BE(offset);
    offset += 2;
    expect(ivLen).toBe(12); // AES-GCM 96-bit nonce is always 12 bytes

    const encDekLen = ct.readUInt16BE(offset);
    offset += 2;
    expect(encDekLen).toBeGreaterThan(0);

    const ctLen = ct.readUInt32BE(offset);
    offset += 4;
    // plaintext (16 bytes) + AES-GCM auth tag (16 bytes) = 32 bytes minimum
    expect(ctLen).toBeGreaterThanOrEqual(32);

    // Total buffer length should exactly match header + declared lengths.
    expect(ct.length).toBe(offset + ivLen + encDekLen + ctLen);

    // The iv field sits immediately after the header at the expected offset.
    const iv = ct.subarray(offset, offset + ivLen);
    expect(iv.length).toBe(12);
    offset += ivLen;

    const encDek = ct.subarray(offset, offset + encDekLen);
    expect(encDek.length).toBe(encDekLen);
    offset += encDekLen;

    const ctWithTag = ct.subarray(offset, offset + ctLen);
    expect(ctWithTag.length).toBe(ctLen);
  });
});
