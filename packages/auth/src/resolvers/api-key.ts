/**
 * resolveApiKey — transport-agnostic API key resolution.
 *
 * Raw keys are minted by generateApiKey() (@oxagen/handlers) as
 * `ox_<base64url(32 bytes)>`. The first `API_KEY_PREFIX_LENGTH` characters are
 * stored verbatim (indexed) as `keyPrefix` for a fast lookup; the full raw key
 * is hashed with SHA-256 and compared against the stored hash. Deleted keys
 * (deletedAt IS NOT NULL) are rejected. Expired keys are rejected with a
 * distinct result so callers can surface a meaningful error.
 *
 * One deleted key gets its own answer: a Tacho host's key that revoking the
 * host retired. Revoking a host deletes its keys and marks the host row
 * `revoked` in one transaction (`revokeHostEnrollment`,
 * @oxagen/database/member-lifecycle), so the host's next request carries a
 * key no live lookup finds. Answered `invalid`, the host could not tell a
 * revocation from a fault and kept retrying for ever. When the key's hash
 * matches and a revoked host names it, the answer is `host_revoked`, which
 * the API serves as 403 with that reason so the host stops shipping.
 *
 * IMPORTANT: the lookup prefix is a FIXED-LENGTH leading WINDOW, never a split
 * on the first "_". The base64url secret can itself contain "_", and every real
 * key begins with the literal "ox_" — splitting on the first underscore would
 * always yield "ox", which would never match the 12-char stored prefix and
 * would reject every real key. Mirror the generator exactly.
 *
 * The key's scope purpose decides who the bearer is. A CLI session key
 * (`cli_session_v1`, minted by the token exchange) authenticates as the user
 * who approved the authorize flow, so `userId` is the key's creator, and it is
 * refused as `invalid` once that user is no longer a member of the key's org
 * or workspace. An agent
 * credential (`agent_credential_v1`, minted by `register_agent`) is locked to
 * the run-token exchange of MC spec §6.2, which no surface serves yet, so it
 * is refused with `purpose_locked` rather than authorizing as its creator.
 * Every other key carries no user.
 *
 * A key never authenticates into an archived workspace (ADR-105). Archiving a
 * workspace retires it as a place work happens, so the machine credentials
 * bound to it stop being accepted here, at the one point where a raw key
 * becomes a tenant scope. The key rows are left alone: archival destroys no
 * credential, and restoring the workspace restores them. A key whose workspace
 * row is missing is refused for the same reason — a scope that cannot be
 * confirmed is not a scope.
 *
 * A key does not get around Require SSO (ADR-145). The web gate admits a
 * non-Owner member of a require-SSO organization only with a session one of
 * that organization's providers made. A key has no session, so the check here
 * is on the person who created it: they must still be a member of the key's
 * organization and either be an Owner there (the same break-glass exemption as
 * the web gate) or have signed in through one of the organization's verified
 * providers at least once, which leaves an `auth.accounts` row naming that
 * provider. That makes them someone the organization's identity provider has
 * vouched for, and someone that removal from the organization or a refused
 * sign-in can reach. Otherwise the key is refused as `sso_required`, whatever
 * its purpose. A key with no creator was minted by the system, not by a
 * person, and the check does not apply to it. Require SSO applies only while
 * the plan includes SSO, as it does at sign-in.
 *
 * This function has no HTTP dependency — it can be called identically from
 * API middleware, MCP handler, CLI, or tests.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import {
  TACHO_GATEWAY_SCOPE_PURPOSE,
  TACHO_HOST_SCOPE_PURPOSE,
} from "@oxagen/database/member-lifecycle";
import { orgHasSso } from "../sso/entitlement";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "@oxagen/oxagen/agent-credential";
import { CLI_SESSION_SCOPE_PURPOSE } from "@oxagen/oxagen/cli-session";

/**
 * Literal leading marker on every raw API key. Mirrors generateApiKey() in
 * @oxagen/handlers. A string that does not start with this is not one of ours.
 */
export const API_KEY_RAW_PREFIX = "ox_";

/**
 * Number of leading characters of the raw key stored (and indexed) as
 * `keyPrefix`. MUST stay in lockstep with generateApiKey() in @oxagen/handlers,
 * which writes `rawKey.slice(0, API_KEY_PREFIX_LENGTH)`. Changing one window
 * length without the other re-introduces the bug where no key resolves.
 */
export const API_KEY_PREFIX_LENGTH = 12;

/**
 * Extract the indexed lookup prefix from a raw key — the fixed leading window
 * that generateApiKey() stored. NOT a delimiter split.
 */
export function apiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX_LENGTH);
}

export interface ApiKeyResult {
  apiKeyId: string;
  orgId: string;
  workspaceId: string;
  /** The key's creator for a CLI session key; null for every other key. */
  userId: string | null;
}

export type ApiKeyResolutionError =
  | { kind: "malformed" }
  | { kind: "invalid" }
  | { kind: "expired" }
  /** The key is locked to a purpose this surface does not serve. */
  | { kind: "purpose_locked" }
  /**
   * The workspace the key names is archived (or no longer resolvable), so the
   * key no longer authenticates into it. The key itself is untouched (ADR-105).
   */
  | { kind: "workspace_archived" }
  /**
   * The key's organization requires SSO and the person who created the key is
   * not a member the organization's identity provider has vouched for (and is
   * not an Owner). The key is genuine. The organization's policy refuses it.
   */
  | { kind: "sso_required" }
  /**
   * The key is a Tacho host's, and an operator revoked that host, which
   * retired the key. No retry changes the answer, so the host stops.
   */
  | { kind: "host_revoked" };

function scopePurposeOf(scope: unknown): string | null {
  return typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    typeof scope.purpose === "string"
    ? scope.purpose
    : null;
}

/** The enrollment a Tacho host or gateway key names, or null for any other key. */
function hostEnrollmentOf(scope: unknown): string | null {
  const purpose = scopePurposeOf(scope);
  if (
    purpose !== TACHO_HOST_SCOPE_PURPOSE &&
    purpose !== TACHO_GATEWAY_SCOPE_PURPOSE
  )
    return null;
  const enrollment = (scope as { host_enrollment_id?: unknown })
    .host_enrollment_id;
  return typeof enrollment === "string" && enrollment !== ""
    ? enrollment
    : null;
}

/**
 * Whether a stored hex hash names the raw key whose digest is `computed`.
 * `timingSafeEqual` throws RangeError when the two buffers differ in length.
 * A corrupted, truncated or odd-length stored hash would otherwise crash the
 * auth path with a 500 instead of a clean auth failure, so the length is
 * checked first: a mismatch can never be a valid key.
 */
function hashMatches(stored: string, computed: Buffer): boolean {
  const storedBuf = Buffer.from(stored, "hex");
  if (storedBuf.length !== computed.length) return false;
  return timingSafeEqual(storedBuf, computed);
}

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
  // Must look like one of our keys: the right literal marker and long enough to
  // carry a secret beyond the indexed prefix window. Reject obvious non-keys
  // before a DB round-trip. (The prefix is the leading window — see apiKeyPrefix
  // — not the chars before the first "_".)
  if (
    !rawKey.startsWith(API_KEY_RAW_PREFIX) ||
    rawKey.length <= API_KEY_PREFIX_LENGTH
  ) {
    return { ok: false, kind: "malformed" };
  }

  const prefix = apiKeyPrefix(rawKey);
  const hash = createHash("sha256").update(rawKey).digest("hex");

  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists)
  // Resolves a raw API key → (apiKeyId, orgId, workspaceId). This IS the
  // resolution step: the apiKeys table carries the pre-bound tenant scope for
  // every machine-auth request. No tenant scope can exist before this lookup
  // completes — the result is used to construct one.
  const row = await withSystemDb((tx) =>
    tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.keyPrefix, prefix),
        isNull(schema.apiKeys.deletedAt),
      ),
      columns: {
        id: true,
        keyHash: true,
        orgId: true,
        workspaceId: true,
        expiresAt: true,
        scope: true,
        createdById: true,
      },
    }),
  );

  const computedHashBuf = Buffer.from(hash, "hex");
  if (!row) {
    return (await revokedHostKey(prefix, computedHashBuf))
      ? { ok: false, kind: "host_revoked" }
      : { ok: false, kind: "invalid" };
  }
  if (!hashMatches(row.keyHash, computedHashBuf))
    return { ok: false, kind: "invalid" };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, kind: "expired" };
  }

  const purpose = scopePurposeOf(row.scope);
  if (purpose === AGENT_CREDENTIAL_SCOPE_PURPOSE) {
    return { ok: false, kind: "purpose_locked" };
  }

  // The key names a workspace; an archived workspace no longer accepts machine
  // authentication (ADR-105). This runs before either bearer branch, so every
  // surface that resolves a key gets the same answer, and it applies to keys
  // minted long before the workspace was archived.
  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists)
  const workspace = await withSystemDb((tx) =>
    tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, row.workspaceId),
      columns: { id: true, archivedAt: true },
    }),
  );
  if (!workspace || workspace.archivedAt !== null) {
    return { ok: false, kind: "workspace_archived" };
  }

  let userId: string | null = null;
  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {
    // A CLI session key speaks for its creator only while the creator is still
    // a member of the key's org and workspace. The bearer path skips the org
    // and workspace middleware's membership checks, so this is where a removed
    // member's key stops working.
    const creatorId = row.createdById;
    if (!creatorId) return { ok: false, kind: "invalid" };
    // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists)
    const member = await withSystemDb(async (tx) => {
      const orgMember = await tx.query.orgUsers.findFirst({
        where: and(
          eq(schema.orgUsers.orgId, row.orgId),
          eq(schema.orgUsers.userId, creatorId),
        ),
        columns: { id: true },
      });
      if (!orgMember) return false;
      const workspaceMember = await tx.query.workspaceUsers.findFirst({
        where: and(
          eq(schema.workspaceUsers.workspaceId, row.workspaceId),
          eq(schema.workspaceUsers.userId, creatorId),
        ),
        columns: { id: true },
      });
      return workspaceMember !== undefined;
    });
    if (!member) return { ok: false, kind: "invalid" };
    userId = creatorId;
  }

  if (
    row.createdById &&
    (await refusedByRequireSso(row.orgId, row.createdById))
  ) {
    return { ok: false, kind: "sso_required" };
  }

  return {
    ok: true,
    apiKeyId: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    userId,
  };
}

/**
 * Whether the raw key is a deleted key of a Tacho host an operator revoked.
 * See the module comment. The deleted row must match the raw key's hash, so
 * a guess at a prefix learns nothing, and a revoked host row must name it:
 * by `api_key_id` for the host's control-plane key (a legacy key carries no
 * scope), or by the enrollment id a host or gateway key's scope records.
 * A key deleted for any other reason stays `invalid`.
 */
async function revokedHostKey(
  prefix: string,
  computedHash: Buffer,
): Promise<boolean> {
  // tenancy: identity resolution before a tenant scope exists, the same prefix lookup as the live one over deleted rows; its orgId is used only after the row is verified by the raw key's hash.
  const retired = await withSystemDb((tx) =>
    tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.keyPrefix, prefix),
        isNotNull(schema.apiKeys.deletedAt),
      ),
      orderBy: [desc(schema.apiKeys.deletedAt)],
      columns: { id: true, keyHash: true, orgId: true, scope: true },
    }),
  );
  if (!retired || !hashMatches(retired.keyHash, computedHash)) return false;
  const enrollment = hostEnrollmentOf(retired.scope);
  // tenancy: identity resolution before a tenant scope exists; filtered by the orgId of the key just verified by its hash.
  const host = await withSystemDb((tx) =>
    tx.query.tachoHosts.findFirst({
      where: and(
        eq(schema.tachoHosts.orgId, retired.orgId),
        eq(schema.tachoHosts.status, "revoked"),
        enrollment === null
          ? eq(schema.tachoHosts.apiKeyId, retired.id)
          : or(
              eq(schema.tachoHosts.apiKeyId, retired.id),
              eq(schema.tachoHosts.publicId, enrollment),
            ),
      ),
      columns: { id: true },
    }),
  );
  return host !== undefined;
}

/**
 * Whether the organization's Require SSO policy refuses a key that
 * `creatorId` created. See the module comment for why the creator is the
 * one checked. An organization without the policy costs one read.
 */
async function refusedByRequireSso(
  orgId: string,
  creatorId: string,
): Promise<boolean> {
  // tenancy: identity resolution before a tenant scope exists; the policy read is filtered by the orgId of the key just verified by its hash.
  const policy = await withSystemDb((tx) =>
    tx.query.orgSecurityPolicy.findFirst({
      where: eq(schema.orgSecurityPolicy.orgId, orgId),
      columns: { ssoRequired: true },
    }),
  );
  if (!policy?.ssoRequired) return false;
  // Off Enterprise, SSO sign-in is refused, so requiring it would lock out
  // every key a non-Owner created (ADR-145).
  if (!(await orgHasSso(orgId))) return false;

  // tenancy: identity resolution before a tenant scope exists; the membership read is filtered by the verified key's orgId and its creator's userId.
  const membership = await withSystemDb((tx) =>
    tx.query.orgUsers.findFirst({
      where: and(
        eq(schema.orgUsers.orgId, orgId),
        eq(schema.orgUsers.userId, creatorId),
      ),
      columns: { role: true },
    }),
  );
  if (!membership) return true;
  if (membership.role.toLowerCase() === "owner") return false;

  // Only a provider this organization registered and whose domain it proved
  // counts. An account from another organization's provider vouches for
  // nothing here.
  // tenancy: identity resolution before a tenant scope exists; filtered by the creator's userId and the verified key's orgId on the provider join.
  const vouched = await withSystemDb((tx) =>
    tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .innerJoin(
        schema.ssoProviderTable,
        eq(schema.ssoProviderTable.providerId, schema.accounts.providerId),
      )
      .where(
        and(
          eq(schema.accounts.userId, creatorId),
          eq(schema.ssoProviderTable.organizationId, orgId),
          eq(schema.ssoProviderTable.domainVerified, true),
        ),
      )
      .limit(1),
  );
  if (vouched.length > 0) return false;

  // Owner by the IAM record too, not only by the org_users role string: the
  // two are written together, and a creator the IAM record makes an Owner
  // keeps the break-glass exemption even if the role string lags.
  // tenancy: identity resolution before a tenant scope exists; filtered by the verified key's orgId and its creator's userId on the principal join.
  const iamOwner = await withSystemDb((tx) =>
    tx
      .select({ id: schema.principalRoleAssignments.id })
      .from(schema.principalRoleAssignments)
      .innerJoin(
        schema.principals,
        eq(schema.principals.id, schema.principalRoleAssignments.principalId),
      )
      .innerJoin(
        schema.roles,
        eq(schema.roles.id, schema.principalRoleAssignments.roleId),
      )
      .where(
        and(
          eq(schema.principalRoleAssignments.orgId, orgId),
          eq(schema.principals.orgId, orgId),
          eq(schema.principals.parentUserId, creatorId),
          eq(schema.principals.kind, "human"),
          eq(schema.roles.name, "Owner"),
          eq(schema.roles.scopeKind, "org"),
          isNull(schema.principalRoleAssignments.workspaceId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .limit(1),
  );
  return iamOwner.length === 0;
}
