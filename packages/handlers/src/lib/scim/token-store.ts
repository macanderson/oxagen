// The organization's SCIM token row, read and written in one place (#3734).
// Callers pass a withSystemDb transaction and have already checked the
// actor's org role; every statement is fenced on orgId.
import { schema, type Tx } from "@oxagen/database";
import { mintScimToken } from "@oxagen/auth/scim-token";
import type { ScimTokenView } from "@oxagen/oxagen/contracts/org.scim_token.shared";
import { and, eq, isNull } from "drizzle-orm";

/** The SCIM base URL under the app host: what the identity provider is given. */
export function scimBaseUrl(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/api/scim/v2`;
}

interface LiveTokenRow {
  id: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export function toScimTokenView(row: LiveTokenRow): ScimTokenView {
  return {
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** The organization's live token, locked when `forUpdate`, or null. */
export async function readLiveScimToken(
  tx: Tx,
  orgId: string,
  forUpdate = false,
): Promise<LiveTokenRow | null> {
  const query = tx
    .select({
      id: schema.scimTokens.id,
      tokenPrefix: schema.scimTokens.tokenPrefix,
      createdAt: schema.scimTokens.createdAt,
      lastUsedAt: schema.scimTokens.lastUsedAt,
    })
    .from(schema.scimTokens)
    .where(
      and(
        eq(schema.scimTokens.orgId, orgId),
        isNull(schema.scimTokens.revokedAt),
      ),
    )
    .limit(1);
  const [row] = forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

/** Mark the live token revoked; answers whether one was. */
export async function revokeLiveScimToken(
  tx: Tx,
  orgId: string,
  actorUserId: string,
): Promise<LiveTokenRow | null> {
  const now = new Date();
  const [revoked] = await tx
    .update(schema.scimTokens)
    .set({
      revokedAt: now,
      revokedById: actorUserId,
      updatedAt: now,
      updatedById: actorUserId,
    })
    .where(
      and(
        eq(schema.scimTokens.orgId, orgId),
        isNull(schema.scimTokens.revokedAt),
      ),
    )
    .returning({
      id: schema.scimTokens.id,
      tokenPrefix: schema.scimTokens.tokenPrefix,
      createdAt: schema.scimTokens.createdAt,
      lastUsedAt: schema.scimTokens.lastUsedAt,
    });
  return revoked ?? null;
}

/** Insert a new live token and answer it with its one-time plaintext. */
export async function insertScimToken(
  tx: Tx,
  orgId: string,
  actorUserId: string,
): Promise<{ token: string; row: LiveTokenRow }> {
  const minted = mintScimToken();
  const [row] = await tx
    .insert(schema.scimTokens)
    .values({
      orgId,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      createdById: actorUserId,
      updatedById: actorUserId,
    })
    .returning({
      id: schema.scimTokens.id,
      tokenPrefix: schema.scimTokens.tokenPrefix,
      createdAt: schema.scimTokens.createdAt,
      lastUsedAt: schema.scimTokens.lastUsedAt,
    });
  if (!row) throw new Error("SCIM token insert returned no row");
  return { token: minted.token, row };
}
