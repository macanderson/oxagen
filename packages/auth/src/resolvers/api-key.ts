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
 * This function has no HTTP dependency — it can be called identically from
 * API middleware, MCP handler, CLI, or tests.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "@oxagen/oxagen/agent-credential";
import { CLI_SESSION_SCOPE_PURPOSE } from "../cli-auth/index";

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
  | { kind: "purpose_locked" };

function scopePurposeOf(scope: unknown): string | null {
  return typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    typeof scope.purpose === "string"
    ? scope.purpose
    : null;
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
        createdByUserId: true,
      },
    }),
  );

  if (!row) return { ok: false, kind: "invalid" };
  const storedHashBuf = Buffer.from(row.keyHash, "hex");
  const computedHashBuf = Buffer.from(hash, "hex");
  // `timingSafeEqual` throws RangeError when the two buffers differ in length.
  // A corrupted/truncated/odd-length `keyHash` in the DB would otherwise crash
  // the auth path with a 500 instead of a clean auth failure. Guard the length
  // first (a mismatch can never be a valid key) and return `invalid`.
  if (storedHashBuf.length !== computedHashBuf.length)
    return { ok: false, kind: "invalid" };
  if (!timingSafeEqual(storedHashBuf, computedHashBuf))
    return { ok: false, kind: "invalid" };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, kind: "expired" };
  }

  const purpose = scopePurposeOf(row.scope);
  if (purpose === AGENT_CREDENTIAL_SCOPE_PURPOSE) {
    return { ok: false, kind: "purpose_locked" };
  }

  if (purpose !== CLI_SESSION_SCOPE_PURPOSE) {
    return {
      ok: true,
      apiKeyId: row.id,
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      userId: null,
    };
  }

  // A CLI session key speaks for its creator only while the creator is still a
  // member of the key's org and workspace. The bearer path skips the org and
  // workspace middleware's membership checks, so this is where a removed
  // member's key stops working.
  const creatorId = row.createdByUserId;
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

  return {
    ok: true,
    apiKeyId: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    userId: creatorId,
  };
}
