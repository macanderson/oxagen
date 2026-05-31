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
 * Parses the Better Auth session cookie out of a raw Cookie header value.
 *
 * Kept in this module so that any transport adapter (HTTP, MCP, CLI) can
 * reuse the same parsing logic without duplicating it.
 *
 * @param cookieHeader - The raw value of the "Cookie" HTTP header (or
 *   equivalent). May be undefined when the header is absent.
 * @returns The decoded session token, or null if the cookie is not present.
 */
export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "better-auth.session_token" && val) {
      return decodeURIComponent(val);
    }
  }
  return null;
}
