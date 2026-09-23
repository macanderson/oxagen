/**
 * Envelope encryption for the secrets inside an SSO provider's configuration
 * (ADR-145).
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
 * Three callers and nothing else:
 *   - the org.sso.* handlers seal before they write a row, and refuse to
 *     write when no KMS is configured (same posture as set_model_credential);
 *   - the auth adapter wrapper in packages/auth opens the tokens when the
 *     plugin reads one row, so the plugin sees a usable config;
 *   - the re-seal job (./sso-reseal.ts) moves tokens onto the current key.
 *
 * A read capability never opens anything: it calls `redactSsoConfig`, which
 * replaces each secret with a boolean "is set" marker. A listing of providers
 * never opens anything either: it calls `stripSsoSecrets`.
 *
 * KEYRING. The key id inside each token names the master key that sealed it.
 * The current key is AUTH_TOKEN_ENCRYPTION_KEY under the id SSO_SECRET_KEY_ID
 * (default `sso_v1`), and every new token is sealed under it. Retired keys stay
 * readable through SSO_SECRET_PREVIOUS_KEYS (`<keyId>=<base64 key>,...`), so a
 * rotation does not break sign-in. `resealSsoConfig` moves a stored config onto
 * the current key, and the sso-reseal job runs it over every provider row.
 */
import { decrypt, encrypt } from "@oxagen/crypto";
import type { KmsAdapter } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";

/**
 * The key id of the current master key when SSO_SECRET_KEY_ID is unset. Every
 * token written before the keyring existed carries it, so those tokens stay
 * readable with no configuration.
 */
export const SSO_SECRET_KEY_ID = "sso_v1";

/** Names the current key's id. Change it together with the key itself. */
export const SSO_SECRET_KEY_ID_ENV = "SSO_SECRET_KEY_ID";

/** Holds retired keys as `<keyId>=<base64 32-byte key>`, comma-separated. */
export const SSO_SECRET_PREVIOUS_KEYS_ENV = "SSO_SECRET_PREVIOUS_KEYS";

/**
 * A key id is a label inside the token, between two colons, and a name in a
 * comma- and equals-separated env var, so none of those characters may appear.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

const TOKEN_PREFIX = "enc:v1:";

export type SsoProtocol = "oidc" | "saml";

export interface ResolvedSsoKms {
  /** The current key. Every new token is sealed under it. */
  readonly adapter: KmsAdapter;
  /** The current key's id, written into every new token. */
  readonly keyId: string;
  /**
   * Every key that can open a token, by key id, the current one included.
   * When absent, only tokens under `keyId` open, with `adapter`.
   */
  readonly keyring?: ReadonlyMap<string, KmsAdapter>;
}

/**
 * A sealed token names a key this server does not hold. The message names the
 * missing key id and the env var that supplies it, never any key material.
 */
export class SsoSecretKeyMissingError extends Error {
  readonly code = "sso_secret_key_missing";
  constructor(readonly keyId: string) {
    super(
      `An SSO provider secret is sealed under key id "${keyId}", which this server does not hold. ` +
        `Add that key to ${SSO_SECRET_PREVIOUS_KEYS_ENV} as ${keyId}=<base64 key>, ` +
        `or set ${SSO_SECRET_KEY_ID_ENV}=${keyId} if it is the current AUTH_TOKEN_ENCRYPTION_KEY.`,
    );
    this.name = "SsoSecretKeyMissingError";
  }
}

/** SSO_SECRET_KEY_ID or SSO_SECRET_PREVIOUS_KEYS cannot be used as written. */
export class SsoSecretKeyringConfigError extends Error {
  readonly code = "sso_secret_keyring_invalid";
  constructor(message: string) {
    super(message);
    this.name = "SsoSecretKeyringConfigError";
  }
}

function checkKeyId(keyId: string, source: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new SsoSecretKeyringConfigError(
      `${source} has the key id "${keyId}". A key id is 1 to 64 letters, digits, "_", "." or "-".`,
    );
  }
}

/**
 * Parse SSO_SECRET_PREVIOUS_KEYS into adapters by key id. Throws on an entry
 * without `=`, a bad or repeated key id, the current key id, or a key that is
 * not 32 bytes of base64. Errors name the key id and never the key.
 */
function parsePreviousKeys(
  raw: string | undefined,
  currentKeyId: string,
): Map<string, KmsAdapter> {
  const out = new Map<string, KmsAdapter>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    // Split at the first "=" only: base64 padding is "=" too.
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new SsoSecretKeyringConfigError(
        `${SSO_SECRET_PREVIOUS_KEYS_ENV} has an entry that is not <keyId>=<base64 key>.`,
      );
    }
    const keyId = trimmed.slice(0, eq).trim();
    checkKeyId(keyId, SSO_SECRET_PREVIOUS_KEYS_ENV);
    if (keyId === currentKeyId) {
      throw new SsoSecretKeyringConfigError(
        `${SSO_SECRET_PREVIOUS_KEYS_ENV} lists "${keyId}", which is the current key id. ` +
          `Give the new key a new ${SSO_SECRET_KEY_ID_ENV}.`,
      );
    }
    if (out.has(keyId)) {
      throw new SsoSecretKeyringConfigError(
        `${SSO_SECRET_PREVIOUS_KEYS_ENV} lists "${keyId}" more than once.`,
      );
    }
    let master: Buffer;
    try {
      master = loadMasterKey(trimmed.slice(eq + 1).trim());
    } catch {
      throw new SsoSecretKeyringConfigError(
        `${SSO_SECRET_PREVIOUS_KEYS_ENV} has a key for "${keyId}" that does not decode to 32 bytes of base64.`,
      );
    }
    out.set(keyId, createLocalKmsAdapter(master));
  }
  return out;
}

/**
 * The KMS used for SSO secrets. Same master key as the model-credential and
 * plugin-credential envelopes (AUTH_TOKEN_ENCRYPTION_KEY). Null when unset,
 * which only happens in local development: a writer must then refuse to store
 * a provider rather than write a plaintext secret.
 *
 * The result seals under the current key and opens under any key in its
 * keyring. Throws SsoSecretKeyringConfigError when the keyring env vars are
 * malformed, so a bad rotation fails loudly at the first read.
 */
export function resolveSsoKms(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedSsoKms | null {
  const key = env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  const keyId = env.SSO_SECRET_KEY_ID?.trim() || SSO_SECRET_KEY_ID;
  checkKeyId(keyId, SSO_SECRET_KEY_ID_ENV);
  const adapter = createLocalKmsAdapter(loadMasterKey(key));
  const keyring = parsePreviousKeys(env.SSO_SECRET_PREVIOUS_KEYS, keyId);
  keyring.set(keyId, adapter);
  return { adapter, keyId, keyring };
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

function deleteAt(obj: Json, path: readonly string[]): void {
  let cur = obj;
  for (const key of path.slice(0, -1)) {
    const next = cur[key];
    if (next === null || typeof next !== "object") return;
    cur = next as Json;
  }
  delete cur[path[path.length - 1]!];
}

function parseObject(stored: string): Json | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Json)
    : null;
}

function clone(config: Json): Json {
  return JSON.parse(JSON.stringify(config)) as Json;
}

async function sealValue(plain: string, kms: ResolvedSsoKms): Promise<string> {
  const envelope = await encrypt(plain, kms.keyId, { adapter: kms.adapter });
  return `${TOKEN_PREFIX}${kms.keyId}:${envelope.toString("base64")}`;
}

function parseToken(token: string): { keyId: string; envelope: Buffer } {
  const rest = token.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) throw new Error("Malformed sealed SSO secret");
  return {
    keyId: rest.slice(0, sep),
    envelope: Buffer.from(rest.slice(sep + 1), "base64"),
  };
}

/** The key that opens tokens under `keyId`, or a named error when none does. */
function adapterFor(kms: ResolvedSsoKms, keyId: string): KmsAdapter {
  const fromRing = kms.keyring?.get(keyId);
  if (fromRing) return fromRing;
  if (keyId === kms.keyId) return kms.adapter;
  throw new SsoSecretKeyMissingError(keyId);
}

async function openValue(token: string, kms: ResolvedSsoKms): Promise<string> {
  const { keyId, envelope } = parseToken(token);
  const plain = await decrypt(envelope, keyId, {
    adapter: adapterFor(kms, keyId),
  });
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
  const out = parseObject(stored);
  if (!out) return stored;
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
 * Move a stored config onto the current key. Returns the JSON text to store
 * when at least one token was sealed under another key id, and null when every
 * token is already under `kms.keyId` (nothing to write). Throws when a token
 * cannot be opened: SsoSecretKeyMissingError when its key is not in the
 * keyring. A plaintext secret is left as it is; plaintextSsoSecretPaths is the
 * check for that.
 */
export async function resealSsoConfig(
  protocol: SsoProtocol,
  stored: string,
  kms: ResolvedSsoKms,
): Promise<string | null> {
  const out = parseObject(stored);
  if (!out) return null;
  let changed = false;
  for (const path of SSO_SECRET_PATHS[protocol]) {
    const value = getAt(out, path);
    if (!isSealedSsoSecret(value)) continue;
    if (parseToken(value).keyId === kms.keyId) continue;
    setAt(out, path, await sealValue(await openValue(value, kms), kms));
    changed = true;
  }
  return changed ? JSON.stringify(out) : null;
}

/**
 * A stored config with every secret path removed, for a listing that must not
 * open anything. Returns null when the text is not a JSON object, so a
 * malformed row reads as having no config instead of failing the listing.
 */
export function stripSsoSecrets(
  protocol: SsoProtocol,
  stored: string,
): string | null {
  const out = parseObject(stored);
  if (!out) return null;
  for (const path of SSO_SECRET_PATHS[protocol]) deleteAt(out, path);
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
