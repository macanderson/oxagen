/**
 * Envelope-encrypted ciphertext returned by `encrypt()` and accepted by
 * `decrypt()`.
 *
 * Wire format (all big-endian):
 *
 *   [1 byte  version    ]
 *   [2 bytes iv_len     ]   uint16 BE, always 12
 *   [2 bytes enc_dek_len]   uint16 BE
 *   [4 bytes ct_len     ]   uint32 BE
 *   [iv_len  bytes iv   ]   AES-GCM 96-bit nonce
 *   [enc_dek_len bytes  ]   KMS-wrapped 256-bit data encryption key
 *   [ct_len  bytes      ]   AES-256-GCM ciphertext || 16-byte auth tag
 *
 * All three length fields are packed into the fixed-size header first; the
 * variable-length payloads follow in order (iv, enc_dek, ct+tag).
 *
 * The version byte lets us migrate the format in the future without
 * re-encrypting all existing rows (just add a decoder branch).
 */
export const ENVELOPE_VERSION = 0x01;

/**
 * KMS adapter interface — the vendor seam.  Any KMS implementation
 * (AWS, GCP, HashiCorp, in-memory mock) must implement this interface.
 * Callers never import a concrete adapter directly; they receive one via
 * `createKmsAdapter()` at the application boundary.
 */
export interface KmsAdapter {
  /**
   * Generate a new 256-bit data encryption key and return both its
   * plaintext form (for immediate use) and its KMS-wrapped form (for
   * storage alongside the ciphertext).
   */
  generateDataKey(
    keyId: string,
  ): Promise<{ plaintext: Uint8Array; encrypted: Uint8Array }>;

  /**
   * Unwrap a KMS-wrapped data encryption key back to plaintext.
   * The `keyId` here is informational / for logging; the
   * actual wrapping key is embedded in the ciphertext blob by the KMS
   * provider.
   */
  decryptDataKey(encrypted: Uint8Array, keyId: string): Promise<Uint8Array>;
}

/** Options accepted by the top-level `encrypt` and `decrypt` helpers. */
export interface EncryptOptions {
  /** The KMS adapter to use for data-key generation / unwrapping. */
  adapter: KmsAdapter;
}

export interface DecryptOptions {
  /** The KMS adapter to use for data-key unwrapping. */
  adapter: KmsAdapter;
}
