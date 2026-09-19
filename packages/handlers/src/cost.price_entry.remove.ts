// `remove_price_entry` (ADR-060 §1): end this organization's negotiated rate
// for one model and token class, so every frame from that instant on resolves
// to the provider list price again.
//
// The row is closed, never deleted — a cost record priced before the instant
// names the entry id it was priced with — and a list row is refused outright:
// the platform's published price is not an organization's to change.
//
// Privileged commercial mutation, so NOT audit-exempt: `billing.plan_changed`
// is the taxonomy's "this organization's commercial terms moved" event, the
// same one the write side emits.
//
// The role gate runs in the handler rather than resting on the contract's
// `defaultRoles`, because the kernel's IAM check allows every capability for a
// non-enterprise organization (INV-29). An API-key call acts as the key's
// creator.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  costPriceEntryRemove,
  type CostPriceEntryRemoveOutput,
} from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import {
  closeNegotiatedPriceEntry,
  loadPriceBook,
  resolvePriceEntry,
  type NegotiatedPriceClose,
  type PriceTokenClass,
} from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { assertDataPlaneUsable, resolveDataPlane } from "@oxagen/tenancy";
import { logger } from "./logger";
import { toPriceEntryDto } from "./lib/price-entry-dto";

export type PriceEntryRemoveDeps = {
  closeNegotiatedPriceEntry: (args: {
    orgId: string;
    provider: string;
    model: string;
    tokenClass: PriceTokenClass;
    region?: string | null;
    at?: Date;
  }) => Promise<NegotiatedPriceClose>;
  /**
   * Reads the book after the close, so the handler can say whether the class
   * actually falls back to a list or override price or whether it becomes
   * unpriced — the two outcomes the dialog and the CLI must not conflate.
   */
  loadPriceBook: (args: { orgId: string }) => ReturnType<typeof loadPriceBook>;
};

export function createPriceEntryRemoveHandler(
  deps: PriceEntryRemoveDeps,
): CapabilityHandler<typeof costPriceEntryRemove> {
  return async (input, ctx): Promise<CostPriceEntryRemoveOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Billing"] },
    );

    // ── The close and the read must land on the same Postgres ─────────────
    //
    // The inverse of the gap `cost.price_entry.set` refuses. The close runs
    // on `withTenantDb` (the organisation's plane); `loadPriceBook` and the
    // rollup read `withSystemDb` (shared). On a dedicated plane the close
    // would find no row, or close a copy the rollup never reads, and answer
    // as if the organisation had returned to list pricing while the shared
    // negotiated rate stayed in force. Refused for the same reason and in the
    // same words. Every organisation is shared today (ADR-042 §1).
    const plane = await resolveDataPlane(ctx.orgId, "postgres");
    if (plane.mode !== "shared") {
      logger.error(
        { orgId: ctx.orgId, planeMode: plane.mode },
        "cost.price_entry.remove: refused — the price book is read from the shared plane only",
      );
      throw new Error(
        "remove_price_entry cannot end a negotiated rate for an organisation on a dedicated " +
          "Postgres plane: cost.price_entries is closed through withTenantDb but read by " +
          "loadPriceBook through withSystemDb, so the shared rate would stay in force " +
          "after the call reported it ended.",
      );
    }
    assertDataPlaneUsable(plane);

    // The row in effect at `at` is closed there; a correction scheduled to
    // start after `at` is cancelled, because it would re-establish the rate
    // the caller just ended. The write instant decides whether a scheduled
    // row has begun — one that has is refused rather than repriced — and the
    // store reads it under its locks, not here: a clock read before the lock
    // wait is stale by the time the guard runs. An omitted `at` defaults to
    // that same instant, so the store answers which instant it used.
    const { at, closed, cancelled } = await deps.closeNegotiatedPriceEntry({
      orgId: ctx.orgId,
      provider: input.provider,
      model: input.model,
      tokenClass: input.tokenClass,
      region: input.region ?? null,
      at: input.at === undefined ? undefined : new Date(input.at),
    });

    // ── Does the class actually fall back, or does it go unpriced? ────────
    //
    // The contract, the CLI and the confirmation dialog all promise "falls
    // back to the list price" — but that is only what happens when a list
    // or override row still prices this model and class. A model this
    // organization negotiated alone (a custom deployment, or a class no
    // catalog publishes) has no such row, and closing its only price leaves
    // every frame from `at` on unpriced rather than list-priced, silently,
    // unless the caller is told. Read after the close, on the same book the
    // rollup resolves against, so a still-open row this call did not touch
    // (nothing was closed, or another source already covers the class)
    // reads as covered without a second guess.
    const fallbackPriced =
      closed === null
        ? true
        : resolvePriceEntry(await deps.loadPriceBook({ orgId: ctx.orgId }), {
            orgId: ctx.orgId,
            modelId: input.model,
            tokenClass: input.tokenClass,
            at,
          }) !== null;

    // ── Audit (SOC 2 CC6.3) ───────────────────────────────────────────────
    // Emitted whether or not a row was open: the request to return a model to
    // list pricing is the event, and a re-run that finds nothing to close is
    // still somebody asking for the organization's terms to move.
    emitSecurityEvent({
      eventType: "billing.plan_changed",
      actorUserId: actingUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: costPriceEntryRemove.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: ctx.orgId,
        actorUserId: actingUserId,
        provider: input.provider,
        model: input.model,
        tokenClass: input.tokenClass,
        region: input.region ?? null,
        at: at.toISOString(),
        closedEntryId: closed?.id ?? null,
        closedMicrosPerMillion: closed?.microsPerMillion.toString() ?? null,
        // Scheduled corrections this end cancelled: never priced anything, so
        // removed; named here because the audit trail is the only place they
        // now exist.
        cancelledEntryIds: cancelled.map((entry) => entry.id),
        fallbackPriced,
        surface: ctx.surface,
      },
      fallbackPriced
        ? "cost.price_entry.remove: negotiated price ended"
        : "cost.price_entry.remove: negotiated price ended with no fallback — the class is unpriced until a new rate or catalog entry covers it",
    );

    return {
      at: at.toISOString(),
      closed: closed === null ? null : toPriceEntryDto(closed),
      fallbackPriced,
    };
  };
}

export const priceEntryRemoveHandler = createPriceEntryRemoveHandler({
  closeNegotiatedPriceEntry,
  loadPriceBook,
});
