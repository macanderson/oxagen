/**
 * Envelope encryption over the KMS adapter seam.
 *
 * AES-256-GCM is the symmetric cipher for the ciphertext payload.
 * The data encryption key (DEK) is generated fresh per encrypt call
 * and wrapped by KMS before being stored alongside the ciphertext.
 *
 * This module NEVER logs plaintext key material or plaintext tokens.
 *
 * No additional authenticated data (AAD) is bound into the envelope: neither
 * the outer AES-GCM nor the wrapped DEK commits to the row, tenant, or column
 * the ciphertext was stored under. Two envelopes produced under the same KEK
 * are therefore interchangeable — swapping one stored blob for another
 * decrypts cleanly. Storage-layer authorization is the only thing preventing
 * that substitution today; binding a context string would need a new
 * ENVELOPE_VERSION.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  ENVELOPE_VERSION,
  type EncryptOptions,
  type DecryptOptions,
} from "./types";

const AES_GCM_IV_BYTES = 12; // 96-bit IV — NIST recommended for AES-GCM
const AES_GCM_TAG_BYTES = 16;
const AES_GCM_KEY_BITS = 256;
const AES_GCM_KEY_BYTES = AES_GCM_KEY_BITS / 8;

/**
 * Encrypt `plaintext` using envelope encryption.
 *
 * 1. KMS generates a fresh 256-bit DEK (both plaintext and KMS-wrapped forms).
 * 2. We AES-256-GCM encrypt `plaintext` with the plaintext DEK.
 * 3. The plaintext DEK is zeroed from memory.
 * 4. We pack a fixed 9-byte header [version | iv_len | enc_dek_len | ct_len]
 *    followed by the variable-length payloads [iv | enc_dek | ct+tag] into a
 *    single Buffer and return it.
 *
 * @param plaintext  The data to encrypt (UTF-8 string or raw Buffer).
 * @param keyId      The KMS CMK id / ARN used to wrap the DEK.
 * @param options    Must supply a `KmsAdapter`.
 */
export async function encrypt(
  plaintext: string | Buffer,
  keyId: string,
  options: EncryptOptions,
): Promise<Buffer> {
  const { adapter } = options;
  const { plaintext: dek, encrypted: encDek } =
    await adapter.generateDataKey(keyId);

  try {
    // Validate key length — KMS should always return 32 bytes for AES_256.
    if (dek.length !== AES_GCM_KEY_BYTES) {
      throw new Error(
        `[crypto] Expected 32-byte DEK from KMS, got ${dek.length}`,
      );
    }

    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });

    const plaintextBuf = Buffer.isBuffer(plaintext)
      ? plaintext
      : Buffer.from(plaintext, "utf8");

    const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ctWithTag = Buffer.concat([ct, tag]);

    // Pack the wire format: a fixed 9-byte header carrying every length field,
    // then the variable-length payloads in the order the header declares them.
    //
    //   header (9 bytes)
    //     [1] version
    //     [2] iv_len       (uint16 BE)
    //     [2] enc_dek_len  (uint16 BE)
    //     [4] ct_len       (uint32 BE)
    //   payloads
    //     [iv_len]      iv
    //     [enc_dek_len] enc_dek
    //     [ct_len]      ciphertext + auth_tag
    const ivLen = iv.length;
    const encDekLen = encDek.length;
    const ctLen = ctWithTag.length;

    const header = Buffer.allocUnsafe(1 + 2 + 2 + 4);
    let offset = 0;
    header.writeUInt8(ENVELOPE_VERSION, offset);
    offset += 1;
    header.writeUInt16BE(ivLen, offset);
    offset += 2;
    header.writeUInt16BE(encDekLen, offset);
    offset += 2;
    header.writeUInt32BE(ctLen, offset);

    return Buffer.concat([header, iv, encDek, ctWithTag]);
  } finally {
    // Zero the plaintext DEK from memory as quickly as possible.
    dek.fill(0);
  }
}

/**
 * Decrypt a ciphertext produced by `encrypt()`.
 *
 * Validates the version byte, unwraps the DEK via KMS, then decrypts the
 * payload with AES-256-GCM.  The GCM auth tag is verified automatically by
 * Node's `createDecipheriv`; a tampered ciphertext throws.
 *
 * @param ciphertext  The Buffer returned by `encrypt()`.
 * @param keyId       The KMS CMK id / ARN (used for logging / routing only;
 *                    the actual wrapping key is embedded in the ciphertext).
 * @param options     Must supply a `KmsAdapter`.
 * @returns           The plaintext as a Buffer.
 */
export async function decrypt(
  ciphertext: Buffer,
  keyId: string,
  options: DecryptOptions,
): Promise<Buffer> {
  const { adapter } = options;

  // Parse the wire format.
  if (ciphertext.length < 1 + 2 + 2 + 4) {
    throw new Error("[crypto] Ciphertext too short to be a valid envelope");
  }

  let offset = 0;
  const version = ciphertext.readUInt8(offset);
  offset += 1;

  if (version !== ENVELOPE_VERSION) {
    throw new Error(
      `[crypto] Unsupported envelope version 0x${version.toString(16).padStart(2, "0")}`,
    );
  }

  const ivLen = ciphertext.readUInt16BE(offset);
  offset += 2;
  const encDekLen = ciphertext.readUInt16BE(offset);
  offset += 2;
  const ctLen = ciphertext.readUInt32BE(offset);
  offset += 4;

  if (ciphertext.length < offset + ivLen + encDekLen + ctLen) {
    throw new Error(
      "[crypto] Ciphertext truncated — header length fields exceed buffer size",
    );
  }

  const iv = ciphertext.subarray(offset, offset + ivLen);
  offset += ivLen;
  const encDek = ciphertext.subarray(offset, offset + encDekLen);
  offset += encDekLen;
  const ctWithTag = ciphertext.subarray(offset, offset + ctLen);

  if (ctWithTag.length < AES_GCM_TAG_BYTES) {
    throw new Error(
      "[crypto] Ciphertext segment too short to contain an AES-GCM auth tag",
    );
  }

  const dek = await adapter.decryptDataKey(encDek, keyId);

  try {
    if (dek.length !== AES_GCM_KEY_BYTES) {
      throw new Error(
        `[crypto] Expected 32-byte DEK from KMS decrypt, got ${dek.length}`,
      );
    }

    const ct = ctWithTag.subarray(0, ctWithTag.length - AES_GCM_TAG_BYTES);
    const tag = ctWithTag.subarray(ctWithTag.length - AES_GCM_TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", dek, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    decipher.setAuthTag(tag);

    // If the auth tag doesn't match (tampered ciphertext), final() throws.
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}
