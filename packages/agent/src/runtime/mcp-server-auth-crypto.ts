/**
 * Envelope-encrypts the secret material stored in `mcp.mcp_servers.auth_config`.
 * This keeps externally-registered MCP servers consistent with plugin-linked
 * servers, whose credentials already flow through the envelope-encrypted
 * `mcp.credentials` path (packages/plugins/src/credentials).
 *
 * This module reuses the SAME crypto primitives as that path
 * (@oxagen/crypto's AES-256-GCM envelope + the local-KEK KMS adapter sourced
 * from AUTH_TOKEN_ENCRYPTION_KEY) rather than inventing new crypto. It uses a
 * distinct key-id label (MCP_SERVER_AUTH_KEY_ID) so the two credential
 * families can be rotated independently.
 *
 * Storage shape (still a jsonb column — no column-type migration needed):
 *   - `{}` (or absent) — no secrets. `authStrategy: "none"` never has any.
 *   - `{ v: 1, kmsKeyId, ciphertext }` — the encrypted form. `ciphertext` is
 *     the base64-encoded envelope (see @oxagen/crypto/envelope) wrapping the
 *     JSON-serialized plaintext record (e.g. `{ token: "..." }` for bearer
 *     auth, or arbitrary header k/v pairs for `header` auth).
 *   - any other shape (bare string keys) — legacy PLAINTEXT row written
 *     before this fix. decryptMcpAuthConfig() passes these through as-is so
 *     reads keep working during rollout; the paired backfill script
 *     (tools/scripts/backfill-mcp-server-auth-config.ts) re-writes every such
 *     row into the encrypted shape.
 *
 * NEVER log plaintext auth_config values or key material from this module.
 */
import { encrypt, decrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";

/** Stable per-row key-version label; bump for rotation (mirrors MCP_CREDENTIAL_KEY_ID). */
export const MCP_SERVER_AUTH_KEY_ID = "mcp_server_auth_v1";

export interface ResolvedMcpServerAuthKms {
  adapter: KmsAdapter;
  keyId: string;
}

/**
 * Resolves the KMS adapter used to envelope-encrypt `mcp_servers.auth_config`.
 * Mirrors packages/plugins/src/credentials/kms.ts: sources the local KEK from
 * AUTH_TOKEN_ENCRYPTION_KEY. Returns null when the key is unset (local dev
 * without secrets) — callers decide how to degrade (see below).
 */
export function resolveMcpServerAuthKms(): ResolvedMcpServerAuthKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: MCP_SERVER_AUTH_KEY_ID,
  };
}

/** The encrypted-at-rest jsonb shape for a non-empty auth_config. */
export interface EncryptedAuthConfig {
  v: 1;
  kmsKeyId: string;
  ciphertext: string;
}

/**
 * Type guard for the encrypted-at-rest shape. Exported so the companion
 * backfill script (tools/scripts/backfill-mcp-server-auth-config.ts) can
 * decide, without duplicating crypto logic, whether a row still needs
 * conversion (a non-empty auth_config that does NOT match this shape is
 * legacy plaintext).
 */
export function isEncryptedAuthConfig(
  value: unknown,
): value is EncryptedAuthConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["ciphertext"] === "string" &&
    typeof (value as Record<string, unknown>)["kmsKeyId"] === "string"
  );
}

/**
 * Encrypt an `auth_config` record before persisting it to
 * `mcp.mcp_servers.auth_config`. An empty/absent record needs no key (there is
 * nothing to protect) and is stored as `{}`. A non-empty record REQUIRES
 * AUTH_TOKEN_ENCRYPTION_KEY — this throws rather than silently persisting
 * plaintext secrets, mirroring setWorkspaceSecret()'s fail-closed behaviour
 * for mcp.credentials.
 */
export async function encryptMcpAuthConfig(
  authConfig: Record<string, string> | null | undefined,
): Promise<Record<string, unknown>> {
  const plain = authConfig ?? {};
  if (Object.keys(plain).length === 0) return {};

  const kms = resolveMcpServerAuthKms();
  if (!kms) {
    throw new Error(
      "[agent] AUTH_TOKEN_ENCRYPTION_KEY required to store mcp_servers.auth_config secrets",
    );
  }
  const buf = await encrypt(JSON.stringify(plain), kms.keyId, {
    adapter: kms.adapter,
  });
  const out: EncryptedAuthConfig = {
    v: 1,
    kmsKeyId: kms.keyId,
    ciphertext: buf.toString("base64"),
  };
  // EncryptedAuthConfig is a precise literal shape (no index signature);
  // the jsonb column accepts any plain object, so widen for the caller.
  return out as unknown as Record<string, unknown>;
}

// Module-level guard: warn at most once per process when a stored row is
// encrypted but AUTH_TOKEN_ENCRYPTION_KEY is absent — the deployment
// misconfiguration should be loud, not spammy.
let kmsAbsentWarned = false;

/**
 * Decrypt a value read from `mcp.mcp_servers.auth_config`. Handles all three
 * shapes documented above: empty, encrypted, and legacy plaintext.
 */
export async function decryptMcpAuthConfig(
  stored: unknown,
): Promise<Record<string, string>> {
  if (stored == null || typeof stored !== "object") return {};
  if (Object.keys(stored as Record<string, unknown>).length === 0) return {};

  if (!isEncryptedAuthConfig(stored)) {
    // Legacy plaintext row (predates this fix) — pass through so existing
    // servers keep working until the backfill script re-encrypts them.
    return stored as Record<string, string>;
  }

  const kms = resolveMcpServerAuthKms();
  if (!kms) {
    if (!kmsAbsentWarned) {
      kmsAbsentWarned = true;
      console.error(
        "[agent] decryptMcpAuthConfig: AUTH_TOKEN_ENCRYPTION_KEY is not set — " +
          "encrypted mcp_servers.auth_config secrets are unreadable; affected " +
          "external MCP servers will fail to authenticate. Set " +
          "AUTH_TOKEN_ENCRYPTION_KEY in the deployment environment.",
      );
    }
    return {};
  }

  const buf = await decrypt(
    Buffer.from(stored.ciphertext, "base64"),
    stored.kmsKeyId,
    {
      adapter: kms.adapter,
    },
  );
  return JSON.parse(buf.toString("utf8")) as Record<string, string>;
}
