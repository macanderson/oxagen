// tacho-host-revoke.ts — the three writes that revoke a Tacho host, in one
// place: the host row becomes `revoked`, its API key is soft-deleted, and a
// `revoke` command is queued so a collector mid-poll learns at once rather
// than at its next bundle refresh. `revoke_tacho_enrollment` runs it for one
// host; `retire_agent` runs it for every live host under the agent's key.
// A column the command row gains later is added here and both callers follow.
import { schema, type Tx } from "@oxagen/database";
import { eq } from "drizzle-orm";

const REVOKE_COMMAND_TTL_MS = 24 * 60 * 60 * 1000;

interface RevocableHost {
  id: string;
  publicId: string;
  apiKeyId: string;
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
      updatedByUserId: args.userId,
    })
    .where(eq(schema.tachoHosts.id, host.id));
  await tx
    .update(schema.apiKeys)
    .set({
      deletedAt: args.now,
      deletedByUserId: args.userId,
      updatedAt: args.now,
      updatedByUserId: args.userId,
    })
    .where(eq(schema.apiKeys.id, host.apiKeyId));
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
    createdByUserId: args.userId,
    updatedByUserId: args.userId,
  });
}
