// Shared authorization + key-material helpers for the api.key.* handlers
// (create / revoke / rotate). Previously resolveActorRole + generateApiKey were
// duplicated across api.key.create and api.key.revoke — this is the single
// source of truth so the three handlers stay in lockstep.

import { createHash, randomBytes } from "node:crypto";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";

/** Org roles permitted to manage API keys. */
export const API_KEY_AUTHORIZED_ROLES = new Set(["Owner", "Admin"]);

/**
 * Resolve the acting user's org-scoped role name, or null when they have no
 * active principal / org-role assignment in this org.
 */
export async function resolveActorOrgRole(
  orgId: string,
  userId: string,
): Promise<string | null> {
  return withTenantDb(async (tx) => {
    const [principalRow] = await tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          eq(schema.principals.parentUserId, userId),
          eq(schema.principals.kind, "human"),
          eq(schema.principals.status, "active"),
        ),
      )
      .limit(1);

    if (!principalRow) return null;

    const [praRow] = await tx
      .select({ roleName: schema.roles.name })
      .from(schema.principalRoleAssignments)
      .innerJoin(
        schema.roles,
        eq(schema.roles.id, schema.principalRoleAssignments.roleId),
      )
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, principalRow.id),
          eq(schema.principalRoleAssignments.orgId, orgId),
          eq(schema.roles.scopeKind, "org"),
          isNull(schema.principalRoleAssignments.workspaceId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .limit(1);

    return praRow?.roleName ?? null;
  });
}

/** True when the user holds an org role permitted to manage API keys. */
export async function actorCanManageApiKeys(
  orgId: string,
  userId: string,
): Promise<boolean> {
  const role = await resolveActorOrgRole(orgId, userId);
  return role !== null && API_KEY_AUTHORIZED_ROLES.has(role);
}

/**
 * Generate a secure API key in the format `ox_<base64url(32 random bytes)>`.
 *
 * `keyPrefix` is the fixed 12-character leading window of the raw key. This
 * window length MUST equal @oxagen/auth's `API_KEY_PREFIX_LENGTH`, which
 * resolveApiKey() uses to look the key up — handlers mints, auth verifies, and
 * the two live in separate packages. Keep the window identical or no key will
 * resolve. Pinned by the generateApiKey prefix-contract test.
 */
export function generateApiKey(): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const rawKey = "ox_" + randomBytes(32).toString("base64url");
  const keyPrefix = rawKey.slice(0, 12); // == @oxagen/auth API_KEY_PREFIX_LENGTH
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  return { rawKey, keyPrefix, keyHash };
}
