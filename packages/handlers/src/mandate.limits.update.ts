// update_mandate_limits — Change limits on an active mandate (ADR-059): the
// limits, targets, the mandate's own approval rule and the validity end.
// The ledger keeps its rows; the next reservation and every read take the
// new perPeriod as the ceiling over what the period has already drawn. A
// limit over a measure a matched tool does not declare is refused as
// grant_mandate refuses it.
// Roles: the consequence roles of every tag (INV-29).

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { lockMandate } from "@oxagen/rules";
import { eq } from "drizzle-orm";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import {
  assertToolsDeclareMeasures,
  loadMandateRow,
  mapMandates,
  requireWorkspace,
} from "./_mandate";
import { logger } from "./logger";

export const mandateLimitsUpdateHandler: CapabilityHandler<
  typeof mandateLimitsUpdate
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "update_mandate_limits");
  const actingUserId = await resolveActingUserId(ctx);
  const { tags, overrides } = await withTenantDb(async (tx) => ({
    tags: (await loadMandateRow(tx, workspaceId, input.mandateId))
      .consequenceTags,
    overrides: await loadConsequenceRoles(tx, workspaceId),
  }));
  await assertConsequenceRole(ctx, tags, overrides);

  const row = await withTenantDb(async (tx) => {
    const current = await loadMandateRow(tx, workspaceId, input.mandateId);
    const locked = await lockMandate(tx, current.id);
    if (!locked || locked.status !== "active") {
      throw new HandlerError({
        code: "conflict",
        reason: "mandate_ended",
        message: `Mandate ${input.mandateId} is ${locked?.status ?? "gone"}; only an active mandate changes`,
      });
    }
    const limits = input.limits ?? locked.limits;
    const targets = input.targets ?? locked.targets;
    if (
      input.validTo !== undefined &&
      Date.parse(input.validTo) <= locked.validFrom.getTime()
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "validity_inverted",
        message: "validTo is after validFrom",
      });
    }
    await assertToolsDeclareMeasures(tx, workspaceId, {
      tools: locked.tools,
      limits,
      targets,
    });
    const [updated] = await tx
      .update(schema.mandates)
      .set({
        limits,
        targets,
        approvalRules: input.approval ?? locked.approval,
        validTo:
          input.validTo !== undefined
            ? new Date(input.validTo)
            : locked.validTo,
        updatedAt: new Date(),
        updatedById: actingUserId ?? undefined,
      })
      .where(eq(schema.mandates.id, locked.id))
      .returning();
    if (!updated)
      throw new Error("[update_mandate_limits] update returned no row");
    return updated;
  });

  emitSecurityEvent({
    eventType: "mandate.limits_changed",
    actorUserId: actingUserId ?? null,
    orgId: ctx.orgId,
    workspaceId,
    capability: "update_mandate_limits",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    { mandateId: row.publicId, workspaceId },
    "update_mandate_limits: changed",
  );
  const [out] = await withTenantDb((tx) => mapMandates(tx, workspaceId, [row]));
  return out!;
};
