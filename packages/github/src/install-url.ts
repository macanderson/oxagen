/**
 * The GitHub App install/identity URLs and the HMAC-signed state they
 * round-trip through GitHub.
 *
 * This lived privately inside `apps/api/src/routes/v1/github-oauth.ts` until a
 * capability handler needed the same install URL (`get_main_repository` hands
 * it to the Workspace settings dialog). A handler cannot import from
 * `apps/api`, and a second copy of an HMAC scheme is a second thing to keep in
 * step: the day one side changes the payload, the encoding or the expiry, the
 * URLs one half of the product mints stop verifying in the other half's
 * callback, and the failure reads as "GitHub rejected it". So there is one
 * implementation, here, in the leaf package both sides already depend on.
 *
 * The state is the security boundary for the callback, which is a public
 * endpoint: it carries the org and workspace the install belongs to, so the
 * callback attaches the installation to the workspace that asked for it and to
 * no other. It is signed, it expires, and it is verified in constant time.
 */
import { createHmac, randomUUID } from "node:crypto";

/** How long a minted state stays valid. Short: it is redeemed in one redirect. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Where the OAuth callback should land the user after a connect. The install
 * now lives in Workspace Settings (1 workspace = 1 app install), while the
 * legacy in-wizard connect still returns to the sources picker. The value is
 * carried in the signed state so the (single, global) callback can route back
 * to the surface the connect started from.
 */
export type GithubConnectReturnTo = "settings" | "sources";

/**
 * Read a `returnTo` off an untrusted state payload. Anything but the literal
 * `"settings"` — including a state minted before the field existed — is
 * `"sources"`, the older of the two surfaces.
 */
export function parseReturnTo(raw: string | undefined): GithubConnectReturnTo {
  return raw === "settings" ? "settings" : "sources";
}

/** Signed-state payload round-tripped through GitHub's `state` query param. */
export interface GithubInstallState {
  orgId: string;
  workspaceId: string;
  /** publicId of a pre-created source_connection, or null for a settings-level connect. */
  connectionId: string | null;
  returnTo: GithubConnectReturnTo;
  expiresAt: number;
  nonce: string;
}

/** What a caller names when minting a state; the rest is generated here. */
export interface GithubInstallStatePayload {
  orgId: string;
  workspaceId: string;
  connectionId: string | null;
  returnTo: GithubConnectReturnTo;
}

/** The HMAC over the exact JSON text that is base64url-encoded into the URL. */
export function buildStateHmac(stateJson: string, secret: string): string {
  return createHmac("sha256", secret).update(stateJson).digest("hex");
}

export function encodeState(stateJson: string): string {
  return Buffer.from(stateJson).toString("base64url");
}

export function decodeState(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

/**
 * Mint the `{base64url_json}.{hmac_hex}` state for one connect attempt, with a
 * fresh nonce and a {@link STATE_TTL_MS} expiry.
 */
export function mintInstallState(
  stateSecret: string,
  payload: GithubInstallStatePayload,
): string {
  const stateJson = JSON.stringify({
    orgId: payload.orgId,
    workspaceId: payload.workspaceId,
    connectionId: payload.connectionId,
    returnTo: payload.returnTo,
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  } satisfies GithubInstallState);

  return `${encodeState(stateJson)}.${buildStateHmac(stateJson, stateSecret)}`;
}

/** Why a state did not verify. The caller maps these to its own wording. */
export type GithubInstallStateError =
  | "invalid_format"
  | "invalid_encoding"
  | "invalid_signature"
  | "invalid_json"
  | "expired";

export type GithubInstallStateResult =
  | { ok: true; state: GithubInstallState }
  | { ok: false; error: GithubInstallStateError };

/**
 * Constant-time comparison of two hex digests. Length is compared first and
 * leaks only the length, which is fixed by the digest; the bytes are compared
 * without an early return, so a wrong signature takes the same time whether it
 * is wrong in the first nibble or the last.
 */
function signaturesMatch(expected: string, received: string): boolean {
  if (received.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verify a state as it came back from GitHub: signature, then shape, then
 * expiry. The failure is returned rather than thrown because the callback
 * answers each one with its own message and status.
 *
 * @param nowMs - Injectable clock for tests; defaults to `Date.now()`.
 */
export function verifyInstallState(
  rawState: string,
  stateSecret: string,
  nowMs: number = Date.now(),
): GithubInstallStateResult {
  // State format: "{base64url_json}.{hmac_hex}"
  const dotIdx = rawState.lastIndexOf(".");
  if (dotIdx === -1) return { ok: false, error: "invalid_format" };

  const encodedState = rawState.slice(0, dotIdx);
  const receivedHmac = rawState.slice(dotIdx + 1);

  let stateJson: string;
  try {
    stateJson = decodeState(encodedState);
  } catch {
    return { ok: false, error: "invalid_encoding" };
  }

  if (!signaturesMatch(buildStateHmac(stateJson, stateSecret), receivedHmac)) {
    return { ok: false, error: "invalid_signature" };
  }

  let state: GithubInstallState;
  try {
    state = JSON.parse(stateJson) as GithubInstallState;
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (nowMs > state.expiresAt) return { ok: false, error: "expired" };

  return { ok: true, state };
}

/**
 * Build the signed GitHub App installation URL (`installations/new?state=…`).
 *
 * Drive the user through the App *installation* flow, NOT the bare
 * `login/oauth/authorize` flow: the connector needs the App installed on the
 * target org to read repos, and `installations/new` both installs the App and —
 * with "Request user authorization (OAuth) during installation" enabled — returns
 * an OAuth `code` to the configured callback. GitHub round-trips the `state` we
 * pass here back to the callback, so it can verify the HMAC and attribute the
 * install to the right org/workspace (and connection, when present). The
 * post-install redirect target is the App's configured Callback URL, so no
 * redirect_uri is passed.
 */
export function buildInstallAuthUrl(
  appSlug: string,
  stateSecret: string,
  payload: GithubInstallStatePayload,
): string {
  const state = mintInstallState(stateSecret, payload);
  return (
    `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new` +
    `?state=${encodeURIComponent(state)}`
  );
}

/**
 * Build the signed GitHub user-authorization URL (`login/oauth/authorize`) — the
 * IDENTITY leg, and the PRIMARY "Connect GitHub" entry point.
 *
 * Why this and not `installations/new`: the install URL only round-trips an OAuth
 * `code` on the FIRST install of the App on an account. Once the App is already
 * installed on an org, GitHub degrades to its stateless Setup-URL "update"
 * redirect, which carries NO `code` and NO signed `state` — so a SECOND Oxagen
 * tenant (a different org/workspace) can never establish its own token and dead-
 * ends at "not connected". The bare user-authorization endpoint has no such
 * dependence: it ALWAYS returns a fresh `code` and echoes our signed `state`,
 * installed-or-not (and silently round-trips with no prompt if the user already
 * authorized). That single fresh `code` is exactly what the callback's
 * oauth_accounts upsert needs, so the second tenant becomes connected and can
 * then attach to the already-installed org via `/user/installations`.
 *
 * GitHub redirects to the App's configured Callback URL (our
 * `/oauth/github/callback`) — the same endpoint the install leg lands on — so no
 * `redirect_uri` is passed.
 */
export function buildIdentityAuthUrl(
  clientId: string,
  stateSecret: string,
  payload: GithubInstallStatePayload,
): string {
  const state = mintInstallState(stateSecret, payload);
  return (
    `https://github.com/login/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

/**
 * Where a person changes which repositories an existing installation reaches.
 * Unsigned on purpose: it starts no flow and carries nothing back — it is the
 * App's own configuration page on GitHub.
 */
export function buildManageInstallationUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

/** GitHub's generic installed-apps page, when no App slug is known. */
export const GITHUB_SETTINGS_INSTALLATIONS_URL =
  "https://github.com/settings/installations";
