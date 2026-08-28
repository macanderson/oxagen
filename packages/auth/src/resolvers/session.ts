/**
 * resolveSession — transport-agnostic session resolution.
 *
 * Accepts a raw Better Auth session token (extracted from a cookie or any
 * other bearer) and returns the userId if the session exists and has not
 * expired. Returns null when the token is not found or is expired — callers
 * must treat null as "no valid session" and decide how to surface the error.
 *
 * The cookie-name parsing deliberately lives in the API / MCP thin wrappers
 * (§7.3 thin-wrapper rule): this function only handles token → userId. It
 * has no HTTP dependency and can be called from CLI, MCP, or tests equally.
 */
import { eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";

export interface SessionResult {
  userId: string;
}

/**
 * The canonical session cookie name used by Better Auth in this application.
 *
 * Better Auth derives the cookie name as `${cookiePrefix}.session_token`.
 * The prefix is configured as "oxagen" in auth.ts (`advanced.cookiePrefix`),
 * making the actual cookie name "oxagen.session_token" — NOT the default
 * "better-auth.session_token". Callers (API middleware, E2E helpers, tests)
 * should reference this constant rather than hardcoding the string.
 */
export const SESSION_COOKIE_NAME = "oxagen.session_token" as const;

/**
 * Cookie-name prefixes Better Auth prepends in production.
 *
 * When `advanced.useSecureCookies` is true (auth.ts sets this for
 * NODE_ENV === "production"), Better Auth renames EVERY cookie with the
 * `__Secure-` prefix — so the real session cookie served over https is
 * `__Secure-oxagen.session_token`, NOT the bare `oxagen.session_token` used in
 * dev/E2E (http, no prefix). `__Host-` is included for forward-compat in case
 * the cookie config tightens to host-locked cookies. The parser must accept
 * the prefixed name or EVERY browser→API call 401s with "Missing credentials"
 * in production while passing locally.
 *
 * Order matters only for readability; each candidate is an exact-match check.
 */
const SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  `__Secure-${SESSION_COOKIE_NAME}`,
  `__Host-${SESSION_COOKIE_NAME}`,
] as const;

/**
 * Expected length of Better Auth's session-cookie HMAC signature suffix.
 *
 * better-call signs cookies as `${token}.${signature}`, where the signature is
 * the standard-base64 encoding of an HMAC-SHA256 digest. A SHA-256 digest is
 * 32 bytes, and base64 of 32 bytes is ceil(32 / 3) * 4 = 44 characters
 * (the final char is "=" padding).
 *
 * This is a documented assumption, not a guarantee: if a Better Auth upgrade
 * changes the signature encoding (e.g. base64url without padding, or a
 * different digest), this length will no longer match and stripCookieSignature
 * will fall through to returning the full value — see the note there. Update
 * this constant if that happens.
 */
export const SESSION_HMAC_SUFFIX_LEN = 44 as const;

/**
 * Strips the HMAC signature appended by Better Auth's cookie signing.
 *
 * Better Auth (via better-call) signs session cookies as:
 *   `${rawToken}.${base64(HMAC-SHA256(secret, rawToken))}`
 *
 * The DB `sessions.token` column stores the raw token without the signature.
 * This function extracts the raw token from the signed value so it can be
 * looked up in the DB.
 *
 * The signature is always a standard base64 string (44 chars ending in "=")
 * separated from the token by the LAST dot. Tokens themselves may contain
 * dots, so we trim from the right.
 *
 * If the value contains no dot at all it is returned as-is (bare token,
 * e.g. from an API test that bypasses cookie signing).
 */
export function stripCookieSignature(signedValue: string): string {
  const lastDot = signedValue.lastIndexOf(".");
  if (lastDot < 0) return signedValue;
  // Better Auth base64 signatures are exactly SESSION_HMAC_SUFFIX_LEN chars
  // (base64 of a 32-byte SHA-256 digest); see the constant for the derivation.
  const suffix = signedValue.slice(lastDot + 1);
  if (suffix.length === SESSION_HMAC_SUFFIX_LEN) {
    return signedValue.slice(0, lastDot);
  }
  // Unexpected suffix length — return the full value and let the DB lookup fail
  // cleanly rather than silently truncating a non-HMAC dot-containing token.
  return signedValue;
}

/**
 * Resolves a raw Better Auth session token to a userId.
 *
 * @param token - The raw session token (already extracted from the cookie or
 *   header — do NOT pass the raw cookie string here).
 * @returns SessionResult on success, null when the token is unknown or
 *   expired.
 */
export async function resolveSession(
  token: string,
): Promise<SessionResult | null> {
  if (!token) return null;

  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists)
  // Resolves a session token → userId. This IS the resolution step: the
  // sessions table is a global auth table (no RLS) and the userId produced here
  // is the input to every downstream scope resolver. No tenant context exists
  // until after this function returns.
  const row = await withSystemDb((tx) =>
    tx.query.sessions.findFirst({
      where: eq(schema.sessions.token, token),
      columns: { userId: true, expiresAt: true },
    }),
  );

  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  return { userId: row.userId };
}

/**
 * Parses the Better Auth session cookie out of a raw Cookie header value
 * and returns the raw (unsigned) token suitable for DB lookup.
 *
 * Better Auth stores the session token as a SIGNED cookie:
 *   name:  `${cookiePrefix}.session_token`  (= "oxagen.session_token")
 *   value: `${rawToken}.${base64HmacSignature}`
 *
 * This function extracts the value, URL-decodes it, then strips the HMAC
 * signature suffix so the returned string matches `sessions.token` in the DB.
 *
 * Kept in this module so that any transport adapter (HTTP, MCP, CLI) can
 * reuse the same parsing logic without duplicating it.
 *
 * @param cookieHeader - The raw value of the "Cookie" HTTP header (or
 *   equivalent). May be undefined when the header is absent.
 * @returns The decoded, unsigned session token, or null if the cookie is
 *   not present.
 */
export function parseSessionCookie(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (val && (SESSION_COOKIE_NAMES as readonly string[]).includes(key)) {
      return stripCookieSignature(decodeURIComponent(val));
    }
  }
  return null;
}
