// revoke_mandate — end a mandate (ADR-059). Under the mandate row lock the
// reservations held by calls parked for approval are released and those
// approval rows expire, so revoking ends in-flight calls that have not
// dispatched (§6.9). A draft is revoked the same way: that is how a request
// is declined. Roles: the consequence roles of every tag (INV-29).

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { lockMandate, releaseParked } from "@oxagen/rules";
import { and, eq, isNull } from "drizzle-orm";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import { loadMandateRow, mapMandates, requireWorkspace } from "./_mandate";
import { logger } from "./logger";

export const mandateRevokeHandler: CapabilityHandler<
  typeof mandateRevoke
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "revoke_mandate");
  const actingUserId = await resolveActingUserId(ctx);
  const { tags, overrides } = await withTenantDb(async (tx) => ({
    tags: (await loadMandateRow(tx, workspaceId, input.mandateId))
      .consequenceTags,
    overrides: await loadConsequenceRoles(tx, workspaceId),
  }));
  await assertConsequenceRole(ctx, tags, overrides);

  const { row, released } = await withTenantDb(async (tx) => {
    const current = await loadMandateRow(tx, workspaceId, input.mandateId);
    const locked = await lockMandate(tx, current.id);
    if (!locked || (locked.status !== "active" && locked.status !== "draft")) {
      throw new HandlerError({
        code: "conflict",
        reason: "mandate_ended",
        message: `Mandate ${input.mandateId} is already ${locked?.status ?? "gone"}`,
      });
    }
    const released = await releaseParked(tx, locked);
    await tx
      .update(schema.approvalRequests)
      .set({ resolution: "expired", resolvedAt: new Date() })
      .where(
        and(
          eq(schema.approvalRequests.mandateId, locked.id),
          isNull(schema.approvalRequests.resolution),
        ),
      );
    const [row] = await tx
      .update(schema.mandates)
      .set({
        status: "revoked",
        revokedBy: actingUserId,
        revokedReason: input.reason,
        revokedAt: new Date(),
        updatedAt: new Date(),
        updatedByUserId: actingUserId ?? undefined,
      })
      .where(eq(schema.mandates.id, locked.id))
      .returning();
    if (!row) throw new Error("[revoke_mandate] update returned no row");
    return { row, released };
  });

  emitSecurityEvent({
    eventType: "mandate.revoked",
    actorUserId: actingUserId ?? null,
    orgId: ctx.orgId,
    workspaceId,
    capability: "revoke_mandate",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    { mandateId: row.publicId, released, workspaceId },
    "revoke_mandate: revoked",
  );
  const [out] = await withTenantDb((tx) => mapMandates(tx, workspaceId, [row]));
  return out!;
};
