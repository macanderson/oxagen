// Shared authorization + key-material helpers for the api.key.* handlers
// (create / revoke / rotate). This is the single source of truth so the
// three handlers stay in lockstep.

import { createHash, randomBytes } from "node:crypto";
import { resolveActorOrgRole } from "@oxagen/iam/org-role";

// The org-role query lives in @oxagen/iam (packages/iam/src/org-role.ts) so
// packages/agent can run the same check; it is re-exported here for the
// api.key.* / tacho.* / telemetry.* handlers that already import it.
export { resolveActorOrgRole };

/** Org roles permitted to manage API keys. */
export const API_KEY_AUTHORIZED_ROLES = new Set(["Owner", "Admin"]);

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
