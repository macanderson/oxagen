// tacho-host-revoke.ts — the three writes that revoke a Tacho host, in one
// place: the host row becomes `revoked`, its API key is soft-deleted, and a
// `revoke` command is queued so a collector mid-poll learns at once rather
// than at its next bundle refresh. `revoke_tacho_enrollment` runs it for one
// host; `retire_agent` runs it for every live host under the agent's key.
// A column the command row gains later is added here and both callers follow.
import { schema, type Tx } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";

const REVOKE_COMMAND_TTL_MS = 24 * 60 * 60 * 1000;

interface RevocableHost {
  id: string;
  publicId: string;
  apiKeyId: string;
}

/**
 * Retire every live credential this enrollment minted, and answer how many.
 *
 * Enrollment mints TWO keys (ADR-078): the host's control-plane key, whose id
 * `tacho_hosts.api_key_id` carries, and the MCP gateway key, whose id is
 * carried nowhere. Deleting `api_key_id` alone left the gateway key valid until
 * expiry, so revoking a lost or copied host did not actually take the connected
 * app's authority away — it kept its read-only MCP mandate.
 *
 * Both keys record `scope.host_enrollment_id` at mint, which is the one thing
 * every credential of a host has in common, so that predicate retires the pair.
 * Unlike a second column it cannot be half-populated for a host enrolled before
 * the change, and it picks up a third credential added later without another
 * edit here.
 *
 * Exported because the already-revoked path needs it WITHOUT the rest of the
 * revocation: a host revoked before this sweep existed still has a live gateway
 * key, and that is exactly the population the sweep is for.
 *
 * Idempotent by construction — `deleted_at IS NULL` means a second call over the
 * same host matches nothing and re-stamps no row.
 */
export async function retireEnrollmentKeys(
  tx: Tx,
  host: RevocableHost,
  args: { orgId: string; userId: string; now: Date },
): Promise<number> {
  const retirement = {
    deletedAt: args.now,
    deletedById: args.userId,
    updatedAt: args.now,
    updatedById: args.userId,
  };
  const swept = await tx
    .update(schema.apiKeys)
    .set(retirement)
    .where(
      and(
        eq(schema.apiKeys.orgId, args.orgId),
        isNull(schema.apiKeys.deletedAt),
        sql`${schema.apiKeys.scope} ->> 'host_enrollment_id' = ${host.publicId}`,
      ),
    )
    .returning({ id: schema.apiKeys.id });
  // The control-plane key is the one credential this host provably has, so its
  // absence from the sweep means the row predates the scope marker or was
  // already retired. Retire it by id rather than leaving a live key behind;
  // `deleted_at IS NULL` makes the second case a no-op rather than a re-stamp.
  if (swept.some((k) => k.id === host.apiKeyId)) return swept.length;
  const byId = await tx
    .update(schema.apiKeys)
    .set(retirement)
    .where(
      and(
        eq(schema.apiKeys.id, host.apiKeyId),
        isNull(schema.apiKeys.deletedAt),
      ),
    )
    .returning({ id: schema.apiKeys.id });
  return swept.length + byId.length;
}

export async function revokeHostEnrollment(
  tx: Tx,
  host: RevocableHost,
  args: {
    orgId: string;
    workspaceId: string;
    userId: string;
    /** Recorded on the host row (null when the operator gave none) and carried in the command. */
    reason: string | null;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(schema.tachoHosts)
    .set({
      status: "revoked",
      revokedAt: args.now,
      revokeReason: args.reason,
      updatedAt: args.now,
      updatedById: args.userId,
    })
    .where(eq(schema.tachoHosts.id, host.id));
  // Every key the enrollment minted, not just the one with a column. Both
  // callers get this: `retire_agent` runs this helper for every live host under
  // an agent, so without it retiring an agent left a gateway key live per host.
  await retireEnrollmentKeys(tx, host, {
    orgId: args.orgId,
    userId: args.userId,
    now: args.now,
  });
  await tx.insert(schema.tachoControlCommands).values({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    hostId: host.id,
    targetKind: "host",
    targetId: host.publicId,
    command: "revoke",
    payload: { reason: args.reason ?? "revoked by operator" },
    reason: args.reason,
    issuedByUserId: args.userId,
    issuedAt: args.now,
    expiresAt: new Date(args.now.getTime() + REVOKE_COMMAND_TTL_MS),
    createdById: args.userId,
    updatedById: args.userId,
  });
}
