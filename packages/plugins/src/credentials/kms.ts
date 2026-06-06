/**
 * Resolves the KMS adapter used to envelope-encrypt plugin credentials.
 *
 * Mirrors packages/auth/src/auth.ts: the local KEK adapter sources its master
 * key from AUTH_TOKEN_ENCRYPTION_KEY (base64 256-bit). When the key is absent
 * (local dev / tests without secrets), this returns null and the caller stores
 * no ciphertext — exactly as the auth package degrades. NEVER log key material.
 */
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";

/** Stable per-row key-version label; bump for rotation. */
export const MCP_CREDENTIAL_KEY_ID = "mcp_cred_v1";

export interface ResolvedKms {
  adapter: KmsAdapter;
  keyId: string;
}

export function resolveCredentialKms(): ResolvedKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: MCP_CREDENTIAL_KEY_ID,
  };
}
