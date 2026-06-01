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
import { db, schema } from "@oxagen/database";

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
 *
 * OXA-1497: was hardcoded as "better-auth.session_token" which never matched
 * the real cookie, breaking all session-based authentication.
 */
export const SESSION_COOKIE_NAME = "oxagen.session_token" as const;

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
  // Better Auth base64 signatures are exactly 44 characters.
  const suffix = signedValue.slice(lastDot + 1);
  if (suffix.length === 44) {
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
export async function resolveSession(token: string): Promise<SessionResult | null> {
  if (!token) return null;

  const row = await db().query.sessions.findFirst({
    where: eq(schema.sessions.token, token),
    columns: { userId: true, expiresAt: true },
  });

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
export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === SESSION_COOKIE_NAME && val) {
      return stripCookieSignature(decodeURIComponent(val));
    }
  }
  return null;
}
