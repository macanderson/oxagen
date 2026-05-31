/**
 * resolveApiKey — transport-agnostic API key resolution.
 *
 * Format: `<prefix>_<secret>`. The prefix is stored in plain text for an
 * index lookup; the full raw key is hashed with SHA-256 and compared against
 * the stored hash. Deleted keys (deletedAt IS NOT NULL) are rejected.
 * Expired keys are rejected with a distinct result so callers can surface a
 * meaningful error.
 *
 * This function has no HTTP dependency — it can be called identically from
 * API middleware, MCP handler, CLI, or tests.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@oxagen/database";

export interface ApiKeyResult {
  apiKeyId: string;
  orgId: string;
  workspaceId: string;
}

export type ApiKeyResolutionError =
  | { kind: "malformed" }
  | { kind: "invalid" }
  | { kind: "expired" };

export type ApiKeyResolution =
  | ({ ok: true } & ApiKeyResult)
  | ({ ok: false } & ApiKeyResolutionError);

/**
 * Resolves a raw API key string to its bound org/workspace scope.
 *
 * @param rawKey - The full API key as supplied by the caller (e.g. the value
 *   after stripping `Bearer ` from the Authorization header).
 * @returns ApiKeyResolution — ok:true with scope on success, ok:false with a
 *   typed error kind on failure. Never throws for auth failures; callers
 *   translate error kinds to appropriate responses.
 */
export async function resolveApiKey(rawKey: string): Promise<ApiKeyResolution> {
  const sep = rawKey.indexOf("_");
  if (sep < 0) return { ok: false, kind: "malformed" };

  const prefix = rawKey.slice(0, sep);
  const hash = createHash("sha256").update(rawKey).digest("hex");

  const row = await db().query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.keyPrefix, prefix), isNull(schema.apiKeys.deletedAt)),
    columns: {
      id: true,
      keyHash: true,
      orgId: true,
      workspaceId: true,
      expiresAt: true,
    },
  });

  if (!row || row.keyHash !== hash) return { ok: false, kind: "invalid" };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, kind: "expired" };
  }

  return {
    ok: true,
    apiKeyId: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
  };
}
