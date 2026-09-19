// Shared authorization + key-material helpers for the api.key.* handlers
// (create / revoke / rotate). This is the single source of truth so the
// three handlers stay in lockstep.

import { createHash, randomBytes } from "node:crypto";
import { schema, withTenantDb } from "@oxagen/database";
import { resolveActorOrgRole } from "@oxagen/iam/org-role";
import { and, eq, isNull } from "drizzle-orm";

// The org-role query lives in @oxagen/iam (packages/iam/src/org-role.ts) so
// packages/agent can run the same check; it is re-exported here for the
// api.key.* / tacho.* / telemetry.* handlers that already import it.
export { resolveActorOrgRole };

/** Org roles permitted to manage API keys. */
export const API_KEY_AUTHORIZED_ROLES = new Set(["Owner", "Admin"]);

/** The request identity an operator capability receives from the kernel. */
export interface OperatorContext {
  orgId: string;
  userId: string | null;
  apiKeyId?: string | null;
}

/**
 * The person an operator capability acts for, or null when there is none.
 *
 * A context that already carries a person is that person, and that is the
 * first line of the function for a reason: `resolveApiKey` is the authority on
 * who a credential speaks for, and where it resolved somebody — a
 * `cli_session_v1` key resolves to the user who approved `oxagen login`, with
 * their org and workspace membership re-checked on every call — the surfaces
 * put that person on the context and this function must not re-litigate it
 * from the scope column.
 *
 * The scope read below is therefore only ever reached for a credential that
 * resolved to NOBODY. It exists for an unscoped key: `oxagen login` used to
 * mint one per sign-in, it is still the only credential some clients hold, and
 * refusing every bearer key made host enrollment impossible from the one
 * client built to do it, so the key's recorded creator stands in.
 *
 * A key whose scope names a purpose and that still arrived with no person is
 * a machine credential — a Tacho host, a Stella telemetry install — and never
 * acts for one: an enrolled machine must not be able to mint, revoke or
 * command enrollments. Any purpose fails closed, including ones added later.
 * Note what that sentence does NOT say: it is not "a purposed key is never a
 * person", which is false of `cli_session_v1` and was the reading that let the
 * five sites answering "what principal is a CLI session key?" disagree with
 * each other. It is "a purposed key that reached here is not one", which is
 * true because reaching here means no surface resolved a person for it.
 *
 * Callers still run their role gate on the returned user, so a key never
 * outlives its creator's Owner/Admin role.
 *
 * `fetchAuthz` (`packages/iam/src/fetch-authz.ts`) answers a different
 * question and is not in tension with this one, even though it still
 * resolves a purpose-scoped key's ROLE GRANTS from its creator (#3151). That
 * is the kernel's generic resolver deciding whose grants a machine key may
 * lean on when the key's own mandate — enforced separately and first, by
 * `machineKeyDenial` in `packages/iam/src/machine-key-scope.ts` — already
 * allows the call. It is not a claim that the key acted for that person, and
 * `fetchAuthz` no longer attributes evidence that way either: it reports the
 * key's purpose back to `checkIAM`, which records a purpose-scoped call
 * against the credential, never the creator. "Acts for a person" here keeps
 * meaning what this function has always meant it to mean — a request only an
 * operator, not any credential, may make.
 */
export async function resolveOperatorUserId(
  ctx: OperatorContext,
): Promise<string | null> {
  if (ctx.userId) return ctx.userId;
  const apiKeyId = ctx.apiKeyId;
  if (!apiKeyId || !ctx.orgId) return null;
  const key = await withTenantDb((tx) =>
    tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.id, apiKeyId),
        eq(schema.apiKeys.orgId, ctx.orgId),
        isNull(schema.apiKeys.deletedAt),
      ),
      columns: {
        scope: true,
        createdById: true,
        stellaTelemetryEnrollmentId: true,
      },
    }),
  );
  if (!key) return null;
  if (key.stellaTelemetryEnrollmentId) return null;
  if (isMachineBoundScope(key.scope)) return null;
  return key.createdById ?? null;
}

function isMachineBoundScope(scope: unknown): boolean {
  return typeof scope === "object" && scope !== null && "purpose" in scope;
}

/**
 * The refusal an operator capability raises when `resolveOperatorUserId`
 * finds no person, worded for the credential that was actually presented.
 */
export function noOperatorMessage(ctx: OperatorContext): string {
  return ctx.apiKeyId
    ? "Unauthorized: this API key does not act for a person (it is bound to an enrolled machine, or has no creator); sign in with `oxagen login`"
    : "Unauthorized: no authenticated user";
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
