/**
 * The SCIM bearer token: how it is made, how it is stored, and how a
 * presented one resolves to its organization (#3734).
 *
 * An identity provider pushes users and groups to /api/scim/v2 with one
 * organization's token. An Owner or Admin mints it on Organization › Single
 * sign-on and sees it once. Oxagen keeps only its SHA-256 in
 * `org.scim_tokens.token_hash`, the way `auth.api_keys.key_hash` keeps a key:
 * the server compares a presented token and never reads one back, so a leaked
 * row gives an attacker nothing to present. The first `SCIM_TOKEN_PREFIX_LENGTH`
 * characters are stored too, indexed, as the lookup window, and are what the
 * page shows to tell one token from the next.
 *
 * The token resolves the organization. A SCIM request cannot name a different
 * one, so there is no organization parameter anywhere on the endpoint.
 *
 * tenancy: system bypass via withSystemDb. A SCIM request has no session and
 * no tenant scope until this lookup names the organization.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

/** The literal marker every SCIM token starts with. */
export const SCIM_TOKEN_RAW_PREFIX = "oxscim_";

/** Leading characters stored and indexed as `token_prefix`. */
export const SCIM_TOKEN_PREFIX_LENGTH = 16;

/** How stale `last_used_at` may get before a request refreshes it. */
const LAST_USED_REFRESH_MS = 5 * 60 * 1000;

export interface MintedScimToken {
  /** The token itself. Shown to the admin once and never stored. */
  token: string;
  tokenPrefix: string;
  tokenHash: string;
}

/** SHA-256 hex of the whole token. */
export function hashScimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new token: the marker and 32 random bytes, base64url. */
export function mintScimToken(): MintedScimToken {
  const token = `${SCIM_TOKEN_RAW_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenPrefix: token.slice(0, SCIM_TOKEN_PREFIX_LENGTH),
    tokenHash: hashScimToken(token),
  };
}

export type ScimTokenResolution =
  | { ok: true; tokenId: string; orgId: string; tokenPrefix: string }
  | { ok: false; kind: "malformed" | "invalid" };

/**
 * Resolve a presented bearer token to its organization, or refuse it. A
 * revoked token is `invalid`, the same answer as one that never existed, so a
 * caller learns nothing about which tokens were once live.
 */
export async function resolveScimToken(
  raw: string,
): Promise<ScimTokenResolution> {
  if (
    !raw.startsWith(SCIM_TOKEN_RAW_PREFIX) ||
    raw.length <= SCIM_TOKEN_PREFIX_LENGTH
  ) {
    return { ok: false, kind: "malformed" };
  }
  const tokenPrefix = raw.slice(0, SCIM_TOKEN_PREFIX_LENGTH);
  // tenancy: bootstrap of a SCIM request, which has no tenant scope until this row names the orgId; filtered by the presented token's prefix and verified by its hash below.
  const row = await withSystemDb(async (tx) => {
    const [found] = await tx
      .select({
        id: schema.scimTokens.id,
        orgId: schema.scimTokens.orgId,
        tokenHash: schema.scimTokens.tokenHash,
        lastUsedAt: schema.scimTokens.lastUsedAt,
      })
      .from(schema.scimTokens)
      .where(
        and(
          eq(schema.scimTokens.tokenPrefix, tokenPrefix),
          isNull(schema.scimTokens.revokedAt),
        ),
      )
      .limit(1);
    return found ?? null;
  });
  if (!row) return { ok: false, kind: "invalid" };

  const stored = Buffer.from(row.tokenHash, "hex");
  const presented = Buffer.from(hashScimToken(raw), "hex");
  if (stored.length !== presented.length) return { ok: false, kind: "invalid" };
  if (!timingSafeEqual(stored, presented)) return { ok: false, kind: "invalid" };

  const now = Date.now();
  if (
    row.lastUsedAt === null ||
    now - row.lastUsedAt.getTime() > LAST_USED_REFRESH_MS
  ) {
    // tenancy: bootstrap of a SCIM request; the write is filtered by the id of the token row just verified by its hash, which names one orgId.
    await withSystemDb((tx) =>
      tx
        .update(schema.scimTokens)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(schema.scimTokens.id, row.id)),
    );
  }
  return { ok: true, tokenId: row.id, orgId: row.orgId, tokenPrefix };
}
