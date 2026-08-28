/**
 * Resolves the KMS adapter used to envelope-encrypt vault secrets.
 *
 * Mirrors credentials/kms.ts but with the vault's own per-row key-version label
 * (`workspace_vault_v1`). Both share the AUTH_TOKEN_ENCRYPTION_KEY master key.
 * When the key is absent (local dev / tests without secrets) this returns null;
 * the service layer then fails writes loudly and locks reads (never silent
 * plaintext). NEVER log key material.
 */
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { ResolvedKms } from "../credentials/kms";

/** Stable per-row key-version label; bump for rotation. */
export const WORKSPACE_VAULT_KEY_ID = "workspace_vault_v1";

export function resolveVaultKms(): ResolvedKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: WORKSPACE_VAULT_KEY_ID,
  };
}

/** Thrown when a sensitive value cannot be encrypted/decrypted (no master key). */
export class VaultLockedError extends Error {
  constructor() {
    super(
      "[vault] AUTH_TOKEN_ENCRYPTION_KEY is not set — sensitive secrets are locked. " +
        "Set AUTH_TOKEN_ENCRYPTION_KEY in the deployment environment.",
    );
    this.name = "VaultLockedError";
  }
}
