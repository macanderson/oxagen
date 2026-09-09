import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
} from "./lib/api-key-authz";
import { logger } from "./logger";

function denied(message: string): CapabilityError {
  return new CapabilityError("dispatch_tacho_command", "authz_denied", message);
}

/**
 * Queue a command (spec section 7.4). Host-level pause/resume/revoke also
 * change the host's status immediately so the next bundle carries it even if
 * the command itself is never fetched.
 */
export const tachoCommandDispatchHandler: CapabilityHandler<
  typeof tachoCommandDispatch
> = async (input, ctx) => {
  if (!ctx.userId) throw denied("Unauthorized: no authenticated user");
  if (!ctx.orgId) throw denied("Forbidden: orgId is required");
  const actorRole = await resolveActorRole(ctx.orgId, ctx.userId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    throw denied(
      "Forbidden: only org Owners and Admins can command Tacho hosts",
    );
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.expiresInS * 1000);

  return withTenantDb(async (tx) => {
    const host = await tx.query.tachoHosts.findFirst({
      where: and(
        eq(schema.tachoHosts.publicId, input.hostEnrollmentId),
        eq(schema.tachoHosts.orgId, ctx.orgId),
      ),
    });
    if (!host) throw denied("Forbidden: unknown Tacho host");
    if (host.status === "revoked")
      throw denied("Forbidden: Tacho host enrollment revoked");

    let sessionId: string | null = null;
    if (input.sessionUuid !== undefined) {
      const session = await tx.query.tachoSessions.findFirst({
        where: and(
          eq(schema.tachoSessions.sessionUuid, input.sessionUuid),
          eq(schema.tachoSessions.hostId, host.id),
        ),
        columns: { id: true },
      });
      if (!session)
        throw denied("Forbidden: session does not belong to this host");
      sessionId = session.id;
    }

    const hostStatus =
      input.sessionUuid !== undefined
        ? undefined
        : input.command === "pause"
          ? "paused"
          : input.command === "resume"
            ? "active"
            : input.command === "revoke"
              ? "suspended"
              : undefined;
    if (hostStatus !== undefined) {
      await tx
        .update(schema.tachoHosts)
        .set({
          status: hostStatus,
          updatedAt: now,
          updatedByUserId: ctx.userId,
        })
        .where(eq(schema.tachoHosts.id, host.id));
    }

    const [row] = await tx
      .insert(schema.tachoControlCommands)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        hostId: host.id,
        sessionId,
        command: input.command,
        payload: {
          ...input.payload,
          ...(input.sessionUuid !== undefined
            ? { session_uuid: input.sessionUuid }
            : {}),
        },
        issuedByUserId: ctx.userId,
        issuedAt: now,
        expiresAt,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({ publicId: schema.tachoControlCommands.publicId });
    if (!row)
      throw new Error("Internal error: failed to queue the Tacho command");
    logger.info(
      {
        orgId: ctx.orgId,
        hostEnrollmentId: input.hostEnrollmentId,
        command: input.command,
      },
      "tacho.command.dispatch: queued",
    );
    return {
      commandId: row.publicId,
      outcome: "pending" as const,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });
};
