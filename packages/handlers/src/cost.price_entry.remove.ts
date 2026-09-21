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
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
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

import { openPriceCancellation } from "./lib/price-cancellation-token";

export type PriceEntryRemoveDeps = {
  closeNegotiatedPriceEntry: (args: {
    orgId: string;
    provider: string;
    model: string;
    tokenClass: PriceTokenClass;
    region?: string | null;
    at?: Date;
    scheduledEntryId?: string;
  }) => Promise<NegotiatedPriceClose>;
  /**
   * Read BEFORE the close, so the handler can refuse rather than leave the
   * class unpriced: the two outcomes the dialog and the CLI must not
   * conflate, and the second one is no longer something the caller only
   * learns about after it already happened. Read again AFTER a close that
   * closed nothing, because an idempotent retry still has to say whether the
   * class is priced.
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

    // ── Does the class have anywhere to fall back to, BEFORE we close it? ──
    //
    // The contract, the CLI and the confirmation dialog all promise closing
    // "falls back to the list price" — but that is only what happens when a
    // list or override row still prices this model and class once this
    // organization's own row is gone. A model this organization negotiated
    // alone (a custom deployment, or a class no catalog publishes) has no
    // such row, and closing its only price would leave every frame from `at`
    // on unpriced rather than list-priced. Checked here, before the close,
    // not after it: reporting the bad news in the output alongside a
    // mutation that already happened is not a warning, because the class was
    // already unpriced by the time anyone read it.
    //
    // Gated on whether an active row of this organization's own is even in
    // the book: a key never negotiated, or already ended, closes nothing
    // (`closeNegotiatedPriceEntry` answers `closed: null`) and must stay the
    // safe no-op a retry relies on — demanding confirmation for a call that
    // changes nothing would turn that idempotent retry into a wall. Only a
    // call that is actually about to end a live rate is asked to confirm
    // going unpriced. `input.at` when given, or a best-effort `now`
    // otherwise: the store computes the real instant under its locks, but
    // the guard only needs to know the picture at roughly the moment of the
    // close, and a race between this read and the store's own lock wait is
    // no worse than the same race the store already runs against a
    // concurrent write.
    let scheduledEntryId = input.scheduledEntryId;
    const cancellation =
      input.cancellationToken === undefined
        ? undefined
        : openPriceCancellation(input.cancellationToken);
    if (cancellation !== undefined) {
      if (
        scheduledEntryId !== undefined ||
        cancellation.orgId !== ctx.orgId ||
        cancellation.provider !== input.provider ||
        cancellation.model !== input.model ||
        cancellation.tokenClass !== input.tokenClass ||
        cancellation.region !== (input.region ?? null)
      )
        throw new HandlerError({
          code: "conflict",
          reason: "price_cancellation_invalid",
          message:
            "This cancellation token does not match the selected rate. Refresh the price book.",
        });
      scheduledEntryId = cancellation.id;
    }
    if (scheduledEntryId !== undefined && input.at !== undefined)
      throw new HandlerError({
        code: "conflict",
        reason: "scheduled_cancellation_at",
        message: "Omit at when cancelling a scheduled rate.",
      });
    const preCloseBook = await deps.loadPriceBook({ orgId: ctx.orgId });
    const selected =
      cancellation === undefined
        ? undefined
        : preCloseBook.find((entry) => entry.id === cancellation.id);
    if (
      selected &&
      (selected.source !== cancellation?.source ||
        selected.effectiveFrom.toISOString() !== cancellation.effectiveFrom)
    )
      throw new HandlerError({
        code: "conflict",
        reason: "price_cancellation_invalid",
        message: "The selected rate changed. Refresh the price book.",
      });
    const guardAt = input.at === undefined ? new Date() : new Date(input.at);
    const activeOwnRow = resolvePriceEntry(preCloseBook, {
      orgId: ctx.orgId,
      modelId: input.model,
      tokenClass: input.tokenClass,
      at: guardAt,
    });
    const hasActiveOwnRow =
      activeOwnRow !== null && activeOwnRow.orgId === ctx.orgId;
    // Excludes every row of this organization's own, not just the one about
    // to close: the row still open in the raw book would otherwise resolve
    // to itself and hide the very gap being asked about, and the business
    // rule of one active row per key means no other own row can be standing
    // in for it either.
    const wouldFallback = hasActiveOwnRow
      ? resolvePriceEntry(
          preCloseBook.filter((entry) => entry.orgId !== ctx.orgId),
          {
            orgId: ctx.orgId,
            modelId: input.model,
            tokenClass: input.tokenClass,
            at: guardAt,
          },
        ) !== null
      : true;

    if (
      scheduledEntryId === undefined &&
      hasActiveOwnRow &&
      !wouldFallback &&
      input.confirmUnpriced !== true
    )
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_close_would_unprice",
        message: `ending the negotiated rate for ${input.model} ${input.tokenClass} would leave it UNPRICED, not list-priced: no list, override, or other negotiated row covers it. Set a fallback price first, or pass confirmUnpriced: true to end the rate anyway.`,
      });

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
      ...(scheduledEntryId === undefined ? {} : { scheduledEntryId }),
    });

    // Nothing was actually closed (already ended, or never negotiated): the
    // guard above ran against a hypothetical close that never happened, so
    // its answer says nothing about this outcome. Neither does `true`, which
    // is what this used to report. The removal is advertised as idempotent,
    // so the path that matters is the retry after a lost response: the first
    // call closed the sole negotiated rate for a custom model nothing else
    // prices, and the retry closed nothing — reporting `fallbackPriced: true`
    // then told the CLI to say the model was back on list pricing and let the
    // app navigate away without the unpriced warning, while every frame from
    // that instant on stayed unpriced. A no-op has to answer the same
    // question a real close does: is this class priced now?
    //
    // So read the book again and resolve it, at the instant the store used.
    // The book is re-loaded rather than reusing the guard's copy because the
    // reason nothing closed may be that another call closed the row between
    // the two — the guard's copy would then still show it open, which is the
    // one picture that cannot be trusted here. One extra query, only on the
    // path that changed nothing.
    //
    // Own rows are NOT excluded this time: the guard excluded them to ask
    // what would remain after a close, and here nothing was closed, so a
    // negotiated row still in force is a real answer to whether the class is
    // priced.
    let fallbackPriced = wouldFallback;
    if (closed === null) {
      const postCloseBook = await deps.loadPriceBook({ orgId: ctx.orgId });
      fallbackPriced =
        resolvePriceEntry(postCloseBook, {
          orgId: ctx.orgId,
          modelId: input.model,
          tokenClass: input.tokenClass,
          at,
        }) !== null;
    }

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
