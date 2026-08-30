/**
 * Ephemeral MCP OAuth PKCE/state store, backed by auth.verifications (TTL'd).
 *
 * Keys are prefixed with "mcp_oauth:" + state. The value is JSON-encoded
 * OAuthStateData with a 10-minute TTL. Expired rows are treated as absent.
 */
import { and, eq, gt } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

const PREFIX = "mcp_oauth:";

export interface OAuthStateData {
  codeVerifier: string;
  orgId: string;
  workspaceId: string;
  orgListingId: string;
  /** Browser path to redirect to after a successful OAuth callback. */
  returnTo: string;
}

export async function saveOAuthState(
  state: string,
  data: OAuthStateData,
  now: number,
): Promise<void> {
  const id = PREFIX + state;
  const expiresAt = new Date(now + 10 * 60 * 1000);
  await withSystemDb(async (tx) => {
    await tx
      .insert(schema.verifications)
      .values({
        id,
        identifier: id,
        value: JSON.stringify(data),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: schema.verifications.id,
        set: { value: JSON.stringify(data), expiresAt, updatedAt: new Date() },
      });
  });
}

export async function loadOAuthState(
  state: string,
  now: number,
): Promise<OAuthStateData | null> {
  const id = PREFIX + state;
  const row = await withSystemDb(async (tx) => {
    const [r] = await tx
      .select({ value: schema.verifications.value })
      .from(schema.verifications)
      .where(
        and(
          eq(schema.verifications.id, id),
          gt(schema.verifications.expiresAt, new Date(now)),
        ),
      )
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  // The stored value may be corrupt, truncated, or tampered with. A parse
  // failure must not crash the OAuth callback handler — treat it as an
  // absent/invalid state so the caller surfaces a clean "expired/missing" error.
  try {
    return JSON.parse(row.value) as OAuthStateData;
  } catch {
    return null;
  }
}

export async function deleteOAuthState(state: string): Promise<void> {
  const id = PREFIX + state;
  await withSystemDb(async (tx) => {
    await tx
      .delete(schema.verifications)
      .where(eq(schema.verifications.id, id));
  });
}
