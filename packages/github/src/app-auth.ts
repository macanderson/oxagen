import { createSign } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.github.com";

// ---------------------------------------------------------------------------
// Module-level cache of minted installation tokens.
//
// The key is (host, app, installation), not the installation alone: installation
// IDs are only unique within one GitHub host, so a bare ID would let a GHES
// installation serve a github.com caller — or one App serve another's — a token
// that grants access it never authorised.
//
// Exported for test inspection only; callers should use getInstallationToken.
// ---------------------------------------------------------------------------

interface CacheEntry {
  token: string;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheKey(args: AppInstallationTokenArgs): string {
  const host = args.baseUrl ?? DEFAULT_BASE_URL;
  return `${host}|${args.appId}|${args.installationId}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlStr(s: string): string {
  return base64url(Buffer.from(s, "utf8"));
}

/**
 * Build an RS256-signed GitHub App JWT.
 *
 * @param appId       - GitHub App ID (iss claim).
 * @param privateKey  - PEM private key. Literal `\n` escapes are normalised to real newlines.
 * @param nowMs       - Current time in ms (injectable for tests).
 */
function buildJwt(appId: string, privateKey: string, nowMs: number): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64urlStr(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }),
  );
  const data = `${header}.${payload}`;
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  const sig = base64url(signer.sign(normalizedKey));
  return `${data}.${sig}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AppInstallationTokenArgs {
  /** GitHub App numeric ID (from the App settings page). */
  appId: string;
  /** PEM-encoded RSA private key. Literal `\n` escapes are normalised. */
  privateKey: string;
  /** Installation ID to mint a token for. */
  installationId: string | number;
  /** Override the GitHub API base URL (useful for testing with a mock server). */
  baseUrl?: string;
  /** Injectable clock (returns ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

export interface InstallationTokenResult {
  token: string;
  /** Expiry as a Unix epoch in milliseconds (matching `Date.now()` semantics). */
  expiresAt: number;
}

interface GHAccessTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Mint a fresh GitHub App installation access token by:
 *   1. Building a signed RS256 JWT from `appId` + `privateKey`.
 *   2. POSTing to `/app/installations/{installationId}/access_tokens`.
 *
 * This function always makes a network request — use `getInstallationToken`
 * for the cached variant.
 */
export async function createAppInstallationToken(
  args: AppInstallationTokenArgs,
): Promise<InstallationTokenResult> {
  const now = args.now ?? (() => Date.now());
  const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const jwt = buildJwt(args.appId, args.privateKey, now());

  const res = await fetch(
    `${baseUrl}/app/installations/${args.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    },
  );

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // fallback to statusText
    }
    throw new Error(`GitHub App token mint failed (${res.status}): ${message}`);
  }

  const body = (await res.json()) as GHAccessTokenResponse;
  return {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  };
}

/**
 * Return a valid GitHub App installation access token, reusing a cached entry
 * when it has more than 60 seconds of lifetime remaining.
 *
 * Tokens GitHub issues for installations are valid for 1 hour. The cache
 * reuses them until 60 seconds before expiry to avoid clock-skew races.
 */
export async function getInstallationToken(
  args: AppInstallationTokenArgs,
): Promise<InstallationTokenResult> {
  const now = args.now ?? (() => Date.now());
  const key = cacheKey(args);
  const cached = _cache.get(key);

  if (cached !== undefined && now() < cached.expiresAt - 60_000) {
    return cached;
  }

  const result = await createAppInstallationToken(args);
  // A token whose expiry did not parse would never satisfy the freshness check
  // above, so caching it only pins a dead entry in memory — skip it.
  if (!Number.isNaN(result.expiresAt)) _cache.set(key, result);
  return result;
}

// Exported for test-only cache inspection / reset.
export { _cache as __tokenCache };
