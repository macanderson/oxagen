// Shared authorization + key-material helpers for the api.key.* handlers
// (create / revoke / rotate). This is the single source of truth so the
// three handlers stay in lockstep.

import { createHash, randomBytes } from "node:crypto";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, gt, isNull, or } from "drizzle-orm";

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
 * A session carries its user. An API key acts for the user who minted it:
 * `oxagen login` mints one per sign-in (POST /v1/auth/cli/token, approved only
 * for an Owner or Admin), and it is the only credential the `tacho` CLI and the
 * desktop app hold — refusing every key made host enrollment impossible from
 * the one client built to do it. The API sets `userId` to null for every
 * bearer key, so without this the handlers saw no person at all.
 *
 * A key whose scope names a purpose was issued to a machine by an enrollment
 * workflow (a Tacho host, a Stella telemetry install) and never acts for a
 * person: an enrolled machine must not be able to mint, revoke or command
 * enrollments. Any purpose fails closed, including ones added later.
 *
 * Callers still run their role gate on the returned user, so a key never
 * outlives its creator's Owner/Admin role.
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
        createdByUserId: true,
        stellaTelemetryEnrollmentId: true,
      },
    }),
  );
  if (!key) return null;
  if (key.stellaTelemetryEnrollmentId) return null;
  if (isMachineBoundScope(key.scope)) return null;
  return key.createdByUserId ?? null;
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

/**
 * Resolve the acting user's org-scoped role name, or null when they have no
 * active principal / unexpired org-role assignment in this org.
 *
 * A principal may hold several org-wide roles at once — `iam.principal_role_
 * assignments` is unique on (principal, role, org), not on (principal, org).
 * Every caller asks "is it in {Owner, Admin}?", so an authorized role wins
 * over any other the principal also holds; taking whichever row Postgres
 * returned first denied a user holding both Admin and Member depending on
 * plan/row order.
 *
 * Time-bounded (JIT) assignments are honored the same way the kernel resolver
 * honors them (`isExpired` in packages/oxagen/src/iam/resolve.ts): an
 * assignment whose `expires_at` is in the past no longer grants its role.
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

    const assigned = await tx
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
          or(
            isNull(schema.principalRoleAssignments.expiresAt),
            gt(schema.principalRoleAssignments.expiresAt, new Date()),
          ),
        ),
      );

    const names = assigned.map((row) => row.roleName);
    return (
      names.find((name) => API_KEY_AUTHORIZED_ROLES.has(name)) ??
      names[0] ??
      null
    );
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
