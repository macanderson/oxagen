/**
 * Local KEK adapter — concrete `KmsAdapter` implementation that wraps data
 * encryption keys with a 256-bit master key (KEK) held in process memory,
 * sourced from an environment variable.  No external KMS / cloud provider is
 * involved: all wrapping is AES-256-GCM via Node's built-in `crypto`.
 *
 * This is the Vercel-native equivalent of a cloud KMS: the KEK lives in
 * Vercel's encrypted environment-variable storage instead of a hardware HSM.
 * OAuth tokens remain encrypted at rest (envelope format unchanged); the only
 * tradeoff vs. a cloud HSM is that the KEK is self-managed and rotation is
 * manual (the per-row key-id label supports versioned rotation).
 *
 * Wrapped-DEK blob layout (input/output of the adapter, embedded as `enc_dek`
 * inside the outer envelope by `encrypt()`):
 *
 *   [12 bytes iv ][16 bytes tag][N bytes ciphertext]
 *
 * Rotation budget: every wrap uses a fresh random 96-bit nonce under the SAME
 * long-lived KEK. NIST SP 800-38D caps a random-IV GCM key at about 2^32
 * invocations before nonce-collision risk stops being negligible, so the KEK
 * must be rotated well before a deployment reaches that many wraps.
 *
 * This module NEVER logs plaintext key material.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { KmsAdapter } from "../types";

const MASTER_KEY_BYTES = 32; // 256-bit KEK
const DEK_BYTES = 32; // 256-bit data encryption key (AES-256)
const IV_BYTES = 12; // 96-bit GCM nonce — NIST recommended
const TAG_BYTES = 16; // 128-bit GCM auth tag
const WRAPPED_LEN = IV_BYTES + TAG_BYTES + DEK_BYTES;

/**
 * Build a `KmsAdapter` that wraps/unwraps DEKs under a local master key.
 *
 * @param masterKey  Raw 256-bit (32-byte) key-encryption key.
 * @throws if the master key is not exactly 32 bytes.
 */
export function createLocalKmsAdapter(masterKey: Buffer): KmsAdapter {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `[crypto/kms/local] master key must be ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`,
    );
  }

  return {
    async generateDataKey(_keyId: string) {
      const dek = randomBytes(DEK_BYTES);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv, {
        authTagLength: TAG_BYTES,
      });
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Wrapped blob: [iv | tag | ciphertext]
      const encrypted = Buffer.concat([iv, tag, ct]);
      return { plaintext: dek, encrypted };
    },

    async decryptDataKey(encrypted: Uint8Array, _keyId: string) {
      const buf = Buffer.from(encrypted);
      if (buf.length !== WRAPPED_LEN) {
        throw new Error(
          `[crypto/kms/local] wrapped data key has unexpected length ${buf.length} (expected ${WRAPPED_LEN})`,
        );
      }
      const iv = buf.subarray(0, IV_BYTES);
      const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ct = buf.subarray(IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv("aes-256-gcm", masterKey, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(tag);
      // A wrong master key or tampered blob makes final() throw.
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    },
  };
}

/**
 * Decode and validate a base64-encoded 256-bit master key.
 *
 * Callers source the value from different env vars — `AUTH_TOKEN_ENCRYPTION_KEY`
 * for auth/plugin credentials, `INGESTION_ENCRYPTION_KEY` for connector
 * credentials — so the error names the value, not any one variable.
 *
 * @throws with a generation hint if the value does not decode to 32 bytes.
 */
export function loadMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `[crypto/kms/local] base64 master key must decode to ${MASTER_KEY_BYTES} bytes ` +
        `(got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}
