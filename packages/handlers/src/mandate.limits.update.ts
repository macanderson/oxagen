// update_mandate_limits — Change limits on an active mandate (ADR-059): the
// limits, targets, the mandate's own approval rule and the validity end.
// The ledger keeps its rows; the next reservation and every read take the
// new perPeriod as the ceiling over what the period has already drawn. A
// limit over a measure a matched tool does not declare is refused as
// grant_mandate refuses it. A change that renames the window of a measure
// that still has reserved or settled authority in the current window, or a
// settlement whose period key overlaps the destination window, is refused
// too: ledger rows keep the old periodKey, while readAuthority and
// reserve would query only the new one, so the draw would vanish from the
// balance and open a second grant of the same ceiling.
// Roles: the consequence roles of every tag (INV-29).
//
// Limits change two ways (ADR-102). `limits` replaces the whole record, which
// is how a bound is deleted. `limitChanges` names the measures to change and
// leaves the rest, and the merge happens HERE, inside the transaction that
// locks the row, over the limits the lock returned. That placement is the
// point: a caller that reads the mandate, merges, and posts the whole record
// back holds a snapshot nobody locked, so two operators changing different
// bounds on one mandate would each write a complete record and the later
// write would restore the bound the earlier one lowered. Restoring a bound
// widens an agent's financial authority with nobody asking, which is the one
// failure a mandate surface must not have.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  lockMandate,
  hasDrawnInCurrentPeriod,
  hasOpenReservation,
  hasSettlementOverlappingPeriod,
} from "@oxagen/rules";
import {
  mandateLimitsSchema,
  type MandateLimitChanges,
  type MandateLimits,
} from "@oxagen/oxagen/mandates/schemas";
import { eq } from "drizzle-orm";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import {
  assertAgentActive,
  assertToolsDeclareMeasures,
  loadMandateRow,
  mapMandates,
  requireWorkspace,
  resolveAgentByPrincipal,
} from "./_mandate";
import { logger } from "./logger";

/**
 * The window a bound takes when the measure it names is not on the record
 * yet. Nothing is widened by it: nothing was bounded before, and the caller
 * that adds a bound without naming a window has said which figure it is
 * capping and not over what. Every other case reads the stored window.
 */
const NEW_LIMIT_PERIOD = "daily";

/**
 * Lay a set of changes over the stored limits at two depths.
 *
 * A bound can be deleted at either depth and a deleted bound is unbounded
 * authority, so both depths keep what they are not told to change: every
 * measure the changes do not name keeps its bound, and within each named
 * measure every field the changes do not carry keeps its stored value —
 * the other sublimit, the unit, and `period`, which a caller editing one
 * figure has said nothing about.
 *
 * The merged record is parsed by `mandateLimitsSchema` rather than asserted
 * into shape, so a change that would leave a bound with no figure or no unit
 * is refused instead of stored. That is reachable only for a measure the
 * record does not hold yet: a change to a stored bound inherits both.
 */
export function applyLimitChanges(
  stored: MandateLimits,
  changes: MandateLimitChanges,
): MandateLimits {
  const merged: Record<string, unknown> = { ...stored };
  for (const [measure, change] of Object.entries(changes)) {
    const before = stored[measure];
    // Built field by field rather than spread, because a key carrying an
    // explicit `undefined` would overwrite a stored value with nothing — the
    // deletion this input cannot express.
    const bound: Record<string, unknown> = { ...before };
    if (change.perCall !== undefined) bound.perCall = change.perCall;
    if (change.perPeriod !== undefined) bound.perPeriod = change.perPeriod;
    if (change.currencyOrUnit !== undefined)
      bound.currencyOrUnit = change.currencyOrUnit;
    bound.period = change.period ?? before?.period ?? NEW_LIMIT_PERIOD;
    merged[measure] = bound;
  }
  const parsed = mandateLimitsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new HandlerError({
      code: "conflict",
      reason: "limit_incomplete",
      message: `The changed limits are not a complete record: ${parsed.error.issues[0]?.message ?? "a bound names no figure or no unit"}`,
    });
  }
  return parsed.data;
}

/**
 * Refuse renaming a measure's window while that measure still has authority
 * drawn under the window the ledger already wrote, an open reservation under
 * any period key, or a settlement whose key overlaps the destination window.
 *
 * Settlements and open reservations keep the periodKey they were filed under.
 * `readAuthority` and `reserve` derive the key from the limit's period alone,
 * so a monthly-to-daily rename would make today's draw invisible and grant the
 * ceiling again. An open reservation that crossed midnight stays under the old
 * day's key after the current window rolls; that row must block the rename
 * too. A settlement from an earlier day in the same week (or month) is the
 * same failure under a daily-to-weekly (or daily-to-monthly) rename: the
 * current-window check misses it and open-reservation ignores settled rows.
 * Leaving the period alone, or changing it when every overlapping key is
 * clear and no reservation is open anywhere, is fine: a bare figure change
 * still binds the same key.
 */
export async function assertPeriodChangeAllowed(
  tx: Parameters<typeof hasDrawnInCurrentPeriod>[0],
  mandateId: string,
  before: MandateLimits,
  after: MandateLimits,
  at: Date = new Date(),
): Promise<void> {
  for (const [measure, next] of Object.entries(after)) {
    const prev = before[measure];
    if (!prev || prev.period === next.period) continue;
    const drawn = await hasDrawnInCurrentPeriod(
      tx,
      mandateId,
      measure,
      prev.period,
      at,
    );
    const open = await hasOpenReservation(tx, mandateId, measure);
    const overlapping = await hasSettlementOverlappingPeriod(
      tx,
      mandateId,
      measure,
      next.period,
      at,
    );
    if (!drawn && !open && !overlapping) continue;
    throw new HandlerError({
      code: "conflict",
      reason: "period_drawn",
      message: `Measure "${measure}" still has authority drawn under its ${prev.period} window, an open reservation under an earlier key, or a settlement that overlaps the ${next.period} window; change the period only when nothing reserved or settled would become invisible under the new key`,
    });
  }
}

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
    // Enforcement uses the exclusive validTo bound, not the status column.
    // The hourly expiry job may not have flipped the row to "expired" yet;
    // without this check an operator could push validTo forward and reopen
    // authority the gate had already stopped honouring.
    const at = new Date();
    if (locked.validTo.getTime() <= at.getTime()) {
      throw new HandlerError({
        code: "conflict",
        reason: "mandate_ended",
        message: `Mandate ${input.mandateId} ended at ${locked.validTo.toISOString()}; only a mandate still inside its validity window changes`,
      });
    }
    // The agent behind this mandate may have retired since it was granted;
    // a retired identity's principal is suspended and can never draw on a
    // widened limit (ADR-104, #3124).
    const agent = await resolveAgentByPrincipal(
      tx,
      workspaceId,
      locked.agentPrincipalId,
    );
    if (agent) assertAgentActive(agent);
    const limits =
      input.limitChanges === undefined
        ? (input.limits ?? locked.limits)
        : applyLimitChanges(locked.limits, input.limitChanges);
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
    // Under the same lock as the write, so a concurrent reserve cannot sneak a
    // draw past the refusal: the row lock serialises both writers.
    await assertPeriodChangeAllowed(tx, locked.id, locked.limits, limits);
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
