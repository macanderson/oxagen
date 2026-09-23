/**
 * Envelope encryption for the secrets inside an SSO provider's configuration
 * (ADR-144).
 *
 * `auth.sso_providers.oidc_config` and `saml_config` are JSON text that the
 * @better-auth/sso plugin parses on every sign-in. The plugin has no decrypt
 * hook, so the secrets inside that JSON (the OIDC client secret, SAML private
 * keys and their passphrases) are sealed IN PLACE: each secret value is
 * replaced by a token of the form
 *
 *     enc:v1:<keyId>:<base64 envelope>
 *
 * where the envelope is `@oxagen/crypto`'s AES-256-GCM output under a fresh
 * data key wrapped by the KMS master key. Everything else in the config
 * (issuer, endpoints, client id, IdP certificate) stays readable, because an
 * operator debugging a sign-in needs it and none of it is secret.
 *
 * Two callers and nothing else:
 *   - the org.sso.* handlers seal before they write a row, and refuse to
 *     write when no KMS is configured (same posture as set_model_credential);
 *   - the auth adapter wrapper in packages/auth opens the tokens when the
 *     plugin reads a row, so the plugin sees a usable config.
 *
 * A read capability never opens anything: it calls `redactSsoConfig`, which
 * replaces each secret with a boolean "is set" marker.
 */
import { decrypt, encrypt } from "@oxagen/crypto";
import type { KmsAdapter } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";

/** Key-version label baked into every token. Bump on a KEK rotation. */
export const SSO_SECRET_KEY_ID = "sso_v1";

const TOKEN_PREFIX = "enc:v1:";

export type SsoProtocol = "oidc" | "saml";

export interface ResolvedSsoKms {
  readonly adapter: KmsAdapter;
  readonly keyId: string;
}

/**
 * The KMS used for SSO secrets. Same master key as the model-credential and
 * plugin-credential envelopes (AUTH_TOKEN_ENCRYPTION_KEY). Null when unset,
 * which only happens in local development: a writer must then refuse to store
 * a provider rather than write a plaintext secret.
 */
export function resolveSsoKms(): ResolvedSsoKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: SSO_SECRET_KEY_ID,
  };
}

/**
 * Where secrets live in each protocol's config. A path is a list of keys from
 * the config root. These are the secret-bearing fields of the plugin's
 * OIDCConfig and SAMLConfig types in @better-auth/sso 1.6.11; a field the
 * plugin adds later is NOT sealed until it is listed here, which is why the
 * handlers build configs from an allowlist rather than passing input through.
 */
export const SSO_SECRET_PATHS: Readonly<
  Record<SsoProtocol, readonly (readonly string[])[]>
> = {
  oidc: [["clientSecret"]],
  saml: [
    ["privateKey"],
    ["decryptionPvk"],
    ["spMetadata", "privateKey"],
    ["spMetadata", "privateKeyPass"],
    ["spMetadata", "encPrivateKey"],
    ["spMetadata", "encPrivateKeyPass"],
    ["idpMetadata", "privateKey"],
    ["idpMetadata", "privateKeyPass"],
    ["idpMetadata", "encPrivateKey"],
    ["idpMetadata", "encPrivateKeyPass"],
  ],
};

/** Whether a value is a sealed token rather than a plaintext secret. */
export function isSealedSsoSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX);
}

type Json = Record<string, unknown>;

function getAt(obj: Json, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

function setAt(obj: Json, path: readonly string[], value: unknown): void {
  let cur = obj;
  for (const key of path.slice(0, -1)) {
    const next = cur[key];
    if (next === null || typeof next !== "object") return;
    cur = next as Json;
  }
  cur[path[path.length - 1]!] = value;
}

function clone(config: Json): Json {
  return JSON.parse(JSON.stringify(config)) as Json;
}

async function sealValue(plain: string, kms: ResolvedSsoKms): Promise<string> {
  const envelope = await encrypt(plain, kms.keyId, { adapter: kms.adapter });
  return `${TOKEN_PREFIX}${kms.keyId}:${envelope.toString("base64")}`;
}

async function openValue(token: string, kms: ResolvedSsoKms): Promise<string> {
  const rest = token.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) throw new Error("Malformed sealed SSO secret");
  const keyId = rest.slice(0, sep);
  const envelope = Buffer.from(rest.slice(sep + 1), "base64");
  const plain = await decrypt(envelope, keyId, { adapter: kms.adapter });
  return plain.toString("utf8");
}

/**
 * Seal every plaintext secret in `config` and return the JSON text to store.
 * Values that are already sealed are kept as they are, so an update that does
 * not change a secret re-stores the existing token rather than re-encrypting.
 */
export async function sealSsoConfig(
  protocol: SsoProtocol,
  config: Json,
  kms: ResolvedSsoKms,
): Promise<string> {
  const out = clone(config);
  for (const path of SSO_SECRET_PATHS[protocol]) {
    const value = getAt(out, path);
    if (typeof value !== "string" || value === "") continue;
    if (isSealedSsoSecret(value)) continue;
    setAt(out, path, await sealValue(value, kms));
  }
  return JSON.stringify(out);
}

/**
 * Open every sealed secret in a stored config and return usable JSON text.
 * Throws when a sealed value is present and no KMS is configured: a sign-in
 * through a provider whose secret cannot be read must fail, not proceed with
 * the token as if it were the secret.
 */
export async function openSsoConfig(
  protocol: SsoProtocol,
  stored: string,
  kms: ResolvedSsoKms | null,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (parsed === null || typeof parsed !== "object") return stored;
  const out = parsed as Json;
  for (const path of SSO_SECRET_PATHS[protocol]) {
    const value = getAt(out, path);
    if (!isSealedSsoSecret(value)) continue;
    if (!kms) {
      throw new Error(
        "An SSO provider secret is sealed but AUTH_TOKEN_ENCRYPTION_KEY is not set",
      );
    }
    setAt(out, path, await openValue(value, kms));
  }
  return JSON.stringify(out);
}

/**
 * The paths in `config` that hold a plaintext secret. Empty for a correctly
 * sealed config. Used as a write-path assertion and by tests.
 */
export function plaintextSsoSecretPaths(
  protocol: SsoProtocol,
  config: Json,
): string[] {
  return SSO_SECRET_PATHS[protocol]
    .filter((path) => {
      const value = getAt(config, path);
      return (
        typeof value === "string" && value !== "" && !isSealedSsoSecret(value)
      );
    })
    .map((path) => path.join("."));
}

/**
 * A config safe to return from a read capability: each secret is replaced by
 * `true` when set, and removed when not. Nothing sealed or plain leaves.
 */
export function redactSsoConfig(protocol: SsoProtocol, config: Json): Json {
  const out = clone(config);
  for (const path of SSO_SECRET_PATHS[protocol]) {
    const value = getAt(out, path);
    if (value === undefined) continue;
    setAt(out, path, typeof value === "string" && value !== "");
  }
  return out;
}
