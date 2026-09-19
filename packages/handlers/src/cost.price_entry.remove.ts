// `remove_price_entry` (ADR-060 §1): end this organization's negotiated rate
// for one model and token class, so every frame from that instant on resolves
// to the provider list price again.
//
// Unless nothing underneath prices it. A custom model, or a class no catalog
// publishes, has no list row and no override to fall back to, and closing the
// negotiated row there does not make the frame cheaper — it makes it
// unpriced, which yields a null cost, so the runs stop carrying a cost at all
// and every surface reads "not recorded". The fallback is resolved before the
// close and a removal with none underneath is refused, because the contract,
// the CLI and the Remove dialog all state the fallback as a fact. An operator
// who means it passes `acknowledgeUnpriced`; either way the answer carries
// the row the model now resolves to.
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
  findNegotiatedPriceEntry,
  loadPriceBook,
  resolveListPriceEntry,
  type NegotiatedPriceClose,
  type PriceBook,
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
  /** The organization's rows and the list, for the fallback check. */
  loadPriceBook: (args: { orgId: string }) => Promise<PriceBook>;
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

    // ── Nothing to fall back to is a refusal, not a silent unpricing ──────
    //
    // Read before the close, from the same shared plane the rollup reads. The
    // instant is the caller's `at`, or now when it omitted one: the store
    // decides the real cutoff under its locks a moment later, and a moment
    // cannot change which list row is in force unless the cutoff lands exactly
    // on that row's boundary — a case where refusing early is the conservative
    // answer, since the operator restates the instant and asks again.
    //
    // The book is read outside the store's lock, so another call could close
    // the list row between this check and the close. That race only widens the
    // refusal, never narrows it: the removal that proceeds is one that had a
    // fallback when it was authorized, and the next read of the book is what
    // the rollup uses anyway.
    const at = input.at === undefined ? undefined : new Date(input.at);
    const asOf = at ?? new Date();
    const book = await deps.loadPriceBook({ orgId: ctx.orgId });
    const fallback = resolveListPriceEntry(book, {
      modelId: input.model,
      tokenClass: input.tokenClass,
      at: asOf,
    });
    // Only a removal that actually closes something can unprice anything. A
    // key this organization never negotiated, or has already ended, answers
    // `closed: null` and changes no price, so it is never refused — a retry
    // after a successful removal must stay the no-op the contract promises.
    const negotiated = findNegotiatedPriceEntry(book, {
      orgId: ctx.orgId,
      provider: input.provider,
      model: input.model,
      tokenClass: input.tokenClass,
      region: input.region ?? null,
      at: asOf,
    });
    if (
      negotiated !== null &&
      fallback === null &&
      input.acknowledgeUnpriced !== true
    ) {
      logger.warn(
        {
          orgId: ctx.orgId,
          provider: input.provider,
          model: input.model,
          tokenClass: input.tokenClass,
          region: input.region ?? null,
          at: asOf.toISOString(),
          negotiatedEntryId: negotiated.id,
          surface: ctx.surface,
        },
        "cost.price_entry.remove: refused — no list price or override can price this model and class, so the close would unprice it",
      );
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_no_fallback",
        message:
          `no list price or override prices ${input.model} (${input.tokenClass}) at ${asOf.toISOString()}, so ending this organization's ` +
          "negotiated rate would not return the frame to the provider list price — it would leave the model unpriced, and an unpriced " +
          "frame records no cost at all rather than a lower one. Set a list price for it, or pass acknowledgeUnpriced to end the rate " +
          "and accept that runs using this model and class stop carrying a cost.",
      });
    }

    // The row in effect at `at` is closed there; a correction scheduled to
    // start after `at` is cancelled, because it would re-establish the rate
    // the caller just ended. The write instant decides whether a scheduled
    // row has begun — one that has is refused rather than repriced — and the
    // store reads it under its locks, not here: a clock read before the lock
    // wait is stale by the time the guard runs. An omitted `at` defaults to
    // that same instant, so the store answers which instant it used.
    const {
      at: closedAt,
      closed,
      cancelled,
    } = await deps.closeNegotiatedPriceEntry({
      orgId: ctx.orgId,
      provider: input.provider,
      model: input.model,
      tokenClass: input.tokenClass,
      region: input.region ?? null,
      at,
    });

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
        at: closedAt.toISOString(),
        closedEntryId: closed?.id ?? null,
        // Null with a row closed is the acknowledged case: from here on this
        // model and class are unpriced, and the runs that use them record no
        // cost. Named in the log because nothing else records that it happened.
        fallbackEntryId: fallback?.id ?? null,
        closedMicrosPerMillion: closed?.microsPerMillion.toString() ?? null,
        // Scheduled corrections this end cancelled: never priced anything, so
        // removed; named here because the audit trail is the only place they
        // now exist.
        cancelledEntryIds: cancelled.map((entry) => entry.id),
        surface: ctx.surface,
      },
      "cost.price_entry.remove: negotiated price ended",
    );

    return {
      at: closedAt.toISOString(),
      closed: closed === null ? null : toPriceEntryDto(closed),
      fallback: fallback === null ? null : toPriceEntryDto(fallback),
    };
  };
}

export const priceEntryRemoveHandler = createPriceEntryRemoveHandler({
  closeNegotiatedPriceEntry,
  loadPriceBook,
});
