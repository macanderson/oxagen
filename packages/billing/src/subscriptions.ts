import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { eq, and, sql } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";
import { readRecordedCustomerId } from "./recorded-customer";
import { getOrgSeatUsage, SeatLimitError } from "./seats";
import { hasPlanUpgradeGrant } from "./grants";
import type { BillingInterval, BillingProrationPreview } from "./provider";

/**
 * Raised when the provider cannot tell us what a change would cost.
 *
 * A quote is allowed to be unavailable; it is not allowed to be invented. The
 * decision path can fall back conservatively because the provider settles the
 * true difference either way, but a number shown to a person before they
 * confirm has no safe default: zero reads as "this is free".
 */
export class PlanChangePreviewUnavailableError extends Error {
  readonly code = "PLAN_CHANGE_PREVIEW_UNAVAILABLE" as const;
  constructor(readonly stripeSubscriptionId: string) {
    super(
      "Could not preview this plan change with the billing provider; no amount can be quoted.",
    );
    this.name = "PlanChangePreviewUnavailableError";
  }
}

/**
 * Raised when the provider cannot say what subscription we are changing.
 *
 * The local row is not a fallback for this. It is written by the sync that
 * runs AFTER a provider mutation, so it is stale in exactly the failure the
 * already-applied guard exists for — and the fallback that used to stand here
 * was only ever safe in the case it was justified by. That justification was
 * "if the provider cannot be reached, the swap cannot be issued either", which
 * is true of an OUTAGE and false of a transient failure of this one read: then
 * the preview and the update both succeed, and the operation proceeds on the
 * stale row the guard exists to distrust (#3157, PR #3171 review).
 *
 * So the fallback had no case where it helped and one where it hurt. In an
 * outage this merely fails earlier, with a error that names the cause instead
 * of one from the swap; in the transient case it refuses to act on state
 * nobody confirmed. This is the same rule
 * {@link PlanChangePreviewUnavailableError} applies one function away: an
 * unknown is not a nothing, and a stale answer is not a known one.
 */
export class SubscriptionStateUnavailableError extends Error {
  readonly code = "SUBSCRIPTION_STATE_UNAVAILABLE" as const;
  constructor(readonly stripeSubscriptionId: string) {
    super(
      "Could not read this subscription's current price and interval from the billing provider; the change was not attempted.",
    );
    this.name = "SubscriptionStateUnavailableError";
  }
}

/**
 * Raised when the change about to be applied would charge more than the
 * customer approved.
 *
 * WHAT THIS BINDS, AND WHY IT IS NOT A STALE READING.
 *
 * The quote a person reads and the charge they get are separated by an HTTP
 * round trip and however long the dialog sits open. `previewPlanChange`
 * computes one preview; `changeOrgPlan` computes another; nothing connects
 * them. A customer shown $0 for a downgrade can confirm and be invoiced an
 * increase, because a discount expired, a credit balance was consumed or the
 * period rolled over between the two (#3157, PR #3171 review, r4042477860).
 *
 * `approvedMaxCents` is not a reading of provider state, and that is the whole
 * reason it is safe to carry across that gap. It is a fact about a HUMAN
 * DECISION — what this person agreed to pay — and a person's approval does not
 * go stale when Stripe's state moves. It is a bound, not a token: acting on it
 * can only ever permit a charge at or below what was agreed, so a stale one
 * cannot authorise anything the fresh one would not.
 *
 * Charging LESS than approved proceeds. The customer agreed to at most this,
 * and a cheaper change is inside that.
 *
 * ABSENT MEANS NO APPROVAL WAS RECORDED, NOT "ANY AMOUNT IS FINE". It is
 * optional because one real caller legitimately has no approved figure: a plan
 * change with no active subscription returns a Stripe Checkout URL, where the
 * customer approves the price on Stripe's own page. Forcing a number there
 * would mean inventing one, and a parameter callers pass a meaningless value
 * for is worse than no parameter. Where a human HAS approved a figure, passing
 * it is what makes the confirmation binding.
 *
 * A PREVIEW THAT CANNOT BE TAKEN REFUSES, when an approval exists. The
 * unpriceable change otherwise settles as `always_invoice`, which bills the
 * true difference — a sound default for a caller with nobody waiting, and the
 * wrong one when a person has been shown a specific number and agreed to it.
 * Not knowing the amount is not permission to charge an unknown one.
 */
export class PlanChangeExceedsApprovedAmountError extends Error {
  readonly code = "PLAN_CHANGE_EXCEEDS_APPROVED_AMOUNT" as const;
  constructor(
    readonly approvedMaxCents: number,
    /** Null when no preview could be taken, so the charge is unknown. */
    readonly chargedNowCents: number | null,
  ) {
    super(
      chargedNowCents === null
        ? `This change was approved at up to ${approvedMaxCents} cents, but what it will charge could not be established; it was not applied.`
        : `This change would charge ${chargedNowCents} cents, more than the ${approvedMaxCents} cents that were approved; it was not applied.`,
    );
    this.name = "PlanChangeExceedsApprovedAmountError";
  }
}

/**
 * Raised when a plan change that was priced as a NEW subscription arrives to
 * find an active one, so the in-place path would run instead of Checkout.
 *
 * WHAT THIS BINDS, AND WHY THE MISSING APPROVAL CANNOT BIND IT.
 *
 * `previewPlanChange` answers `requiresCheckout: true` when the org has no
 * active subscription. A caller acting on that shows no confirmation dialog
 * and approves no figure — correctly, because on that path the customer
 * approves the price on Stripe's own hosted page, and inventing a number for
 * it would make {@link PlanChangeExceedsApprovedAmountError} meaningless.
 *
 * But the preview and the submit are separated by an HTTP round trip, and the
 * fact the preview read is provider state. A Checkout completed in another
 * tab, or a webhook sync landing in between, gives the org an active
 * subscription — and `changeOrgPlan` then takes the in-place path, where the
 * approval gate is keyed on `approvedMaxCents !== undefined` and so does not
 * run at all. The result is an immediate `always_invoice` proration nobody was
 * shown (#3157, PR #3171 review, r4042742296).
 *
 * THE DISCRIMINATOR IS THE CLAIM, NOT THE MISSING AMOUNT. "No approved figure"
 * cannot mean "refuse the in-place path": absence has one settled meaning here
 * — no approval was recorded — and every caller with no human behind it relies
 * on it. Making absence a refusal would refuse them all.
 *
 * What separates the unsafe case from the safe one is what the submit
 * BELIEVED. A submit made on the strength of a `requiresCheckout: true`
 * preview is asserting a piece of provider state, and provider state moves. So
 * the caller states the assertion explicitly and the server refuses when it no
 * longer holds — the same shape as `expectedCurrentPriceId` on the swap
 * itself, one step earlier in the same request.
 *
 * The remedy is a fresh preview: with a subscription now in place it returns
 * `requiresCheckout: false` and a proration figure, the caller shows it, and
 * the change becomes one a person has approved.
 */
export class PlanChangeCheckoutStateMovedError extends Error {
  readonly code = "PLAN_CHANGE_CHECKOUT_STATE_MOVED" as const;
  constructor(readonly stripeSubscriptionId: string) {
    super(
      "This change was priced as a new subscription, but an active subscription now exists, so it would have been billed as an immediate change instead; it was not applied. Preview the change again to see what it will cost.",
    );
    this.name = "PlanChangeCheckoutStateMovedError";
  }
}

/** Which way the money moves across a plan change, and what the swap owes now. */
export interface PlanChangeDirection {
  prorationBehavior: "always_invoice" | "none";
  direction:
    | "increase"
    | "decrease"
    | "unchanged"
    | "interval_change"
    | "unknown";
  /**
   * What the change bills now, in cents. For a same-interval change that is
   * the net proration; for an interval change it is the whole invoice the
   * anchor reset raises. Null means the preview was unavailable — NEVER zero,
   * which would read as "nothing to pay".
   */
  amountCents: number | null;
  /** The previewed invoice itself; null when the preview could not be taken. */
  preview: BillingProrationPreview | null;
}

/**
 * Which way a plan change moves the money, measured by previewing the invoice
 * the change would raise.
 *
 * WHY A PREVIEW AND NOT A FIELD. Three times this decision has been made from
 * something that stands in for the money, and three times the stand-in has
 * inverted:
 *
 *  1. The entitlement tier rank was a proxy for price — until Enterprise was
 *     priced below Scale (#3157).
 *  2. The `billing.plans` row was a proxy for what the subscriber pays — until
 *     a reprice left grandfathered subscribers on an older, immutable price.
 *  3. `price.unit_amount` was a proxy for what the subscriber pays — until a
 *     discount. `allow_promotion_codes` is set on both checkout paths, so a
 *     $200 price discounted to $100 moving to an undiscounted $150 read as a
 *     decrease and dropped the charge, exactly as the first two did.
 *
 * Each fix replaced a proxy with a closer proxy, and each closer proxy had its
 * own inversion. The preview is not a closer proxy; it is the money. Stripe
 * computes the prorated credit for unused time on the old price and the
 * prorated charge for the new one, applies the customer's discounts, and
 * returns the net. Positive means the change bills more. There is no fourth
 * field to be wrong about.
 *
 * The preview runs under `create_prorations`, which produces the same
 * proration lines `always_invoice` would and issues no invoice, so asking the
 * question does not charge anybody. `none` is not usable here: it produces no
 * proration lines at all, so it cannot answer what it is being asked.
 *
 * A preview that cannot be obtained settles as `always_invoice`. That asks
 * Stripe to compute the true difference and settle it in whichever direction
 * it falls — a credit if the bill went down. `none` is the branch that
 * silently drops money, so it is never the fallback.
 *
 * The entitlement ordering in `entitlements.ts` (`TIER_ORDER` /
 * `meetsMinimumTier`) answers a different question — *does this plan include
 * that feature?* — and is never read here.
 *
 * WHETHER THE INTERVAL CHANGES IS MEASURED HERE, FROM THE PREVIEW ITSELF.
 *
 * This used to take a boolean the caller had computed, from an interval the
 * caller had read with its own `getSubscription`. Two provider reads of one
 * remote object in one logical operation, and nothing holds them together: a
 * plan update landing in between makes the boolean describe the subscription
 * before it and the preview describe the subscription after it. Caller sees
 * monthly, the preview is computed on annual, this request targets monthly —
 * `false` is passed, the annual→monthly credit reads as a downgrade, `none` is
 * selected and the quote is $0, while the provider resets the anchor and
 * invoices the whole new month. The customer is charged a month they were told
 * was free (#3157, PR #3171 review, r4042249142).
 *
 * So the caller passes the interval it is ASKING FOR — a request parameter,
 * which cannot go stale because it is not a reading of anything — and the
 * interval being moved FROM comes back on the preview, off the same PROVIDER
 * REQUEST that priced it. One observation, one comparison, nothing to keep in
 * step. The alternative on offer was to verify the subscription had not
 * changed between the two reads, which is two values plus a check that can
 * itself go stale between passing and being acted on; SCR-002 takes the option
 * that cannot be questioned later, and not fetching a second copy is that
 * option.
 *
 * That took two rounds to get right, and the first round is worth recording
 * because it looked finished. Moving the field onto the preview closed the gap
 * between THIS function's caller and the preview, and the adapter then filled
 * it from the subscription it had retrieved to find the item to reprice — a
 * second request, one layer down, with the same window and the same defect
 * inside it. A required parameter made the adapter state which subscription it
 * meant; it could not make that the subscription the invoice was priced
 * against. The preview now reports its own subscription, expanded onto the
 * response that computes it (#3157, PR #3171 review, r4042249142 then
 * r4042380655).
 */
async function planChangeDirection(
  stripeSubscriptionId: string,
  newPriceId: string,
  /**
   * The interval being moved TO. Not a reading of provider state — it is what
   * this request asks for, so it has no staleness to have.
   */
  targetInterval: BillingInterval,
): Promise<PlanChangeDirection> {
  try {
    const preview = await billingProvider().previewPlanChange(
      stripeSubscriptionId,
      { newPriceId, prorationBehavior: "create_prorations" },
    );

    // An interval change is not a downgrade, whichever way the proration
    // nets out. Changing the recurring interval resets the billing-cycle
    // anchor at the provider, which invoices the new period IMMEDIATELY —
    // with prorations disabled or not. An annual subscriber moving to a
    // monthly plan previews a negative proration (credit for unused time) and
    // would take the `none` branch, so the confirmation said $0 while a full
    // month was charged. The money owed is the whole invoice, not the
    // proration lines, so it is billed under always_invoice rather than
    // silently dropped.
    //
    // Quoted from `amountDueCents`, not `totalCents`. This number is shown to
    // a person as what happens to their card now, and a customer carrying a
    // credit balance is not charged the total — Stripe applies the balance and
    // collects `amount_due`. The total overstated the charge by the whole
    // balance (#3157, PR #3171 review).
    //
    // The interval moved FROM is the preview's own: the subscription the
    // priced invoice reports, on the response that priced it, not a retrieval
    // taken beside it. See the header and
    // BillingProrationPreview.billingInterval.
    const intervalChanges = preview.billingInterval !== targetInterval;
    if (intervalChanges) {
      return {
        prorationBehavior: "always_invoice",
        direction: "interval_change",
        amountCents: preview.amountDueCents,
        preview,
      };
    }

    const amountCents = preview.amountCents;
    const direction =
      amountCents > 0 ? "increase" : amountCents < 0 ? "decrease" : "unchanged";
    return {
      prorationBehavior: direction === "increase" ? "always_invoice" : "none",
      direction,
      amountCents,
      preview,
    };
  } catch (err) {
    logger.warn(
      { stripeSubId: stripeSubscriptionId, newPriceId, err },
      "billing: plan-change preview failed — settling as always_invoice so the true difference is billed either way",
    );
    return {
      prorationBehavior: "always_invoice",
      direction: "unknown",
      amountCents: null,
      preview: null,
    };
  }
}

/**
 * Pulls the canonical subscription record from the billing provider and
 * upserts into billing.subscriptions. Idempotent on stripe_subscription_id.
 * The webhook handler invokes this for every subscription.* event so our
 * table mirrors the provider within one round trip.
 *
 * tenancy: system bypass via withSystemDb (called from webhook dispatch, no tenant
 * scope; org resolved from Stripe subscription metadata).
 */
export async function syncSubscriptionFromStripe(
  stripeSubId: string,
): Promise<void> {
  const start = Date.now();
  const sub = await billingProvider().getSubscription(stripeSubId);

  const orgId = sub.metadata?.org_id ?? null;
  if (!orgId) {
    // No tenant metadata = subscription was created outside our flow.
    // Bail silently; later events may carry the tenant once attached.
    logger.warn(
      { stripeSubId },
      "billing: subscription has no org_id metadata, skipping sync",
    );
    return;
  }

  // Track whether this sync represents a Stripe-initiated cancellation so we can
  // emit an audit row outside the write transaction. The billing UI emits
  // billing.subscription_canceled when a USER cancels; a subscription can also
  // be canceled by Stripe itself (dunning exhaustion, non-payment, or an action
  // in the Stripe dashboard) with no UI path — those would otherwise leave no
  // SOC2 audit trail. We detect the transition INTO "canceled" here.
  let canceledTransition = false;

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (webhook path, resolves plan from Stripe
    // product id before a tenant scope exists; billing tables are org_only).
    const plan = await tx.query.plans.findFirst({
      where: eq(schema.plans.stripeProductId, sub.productId ?? ""),
      columns: { id: true },
    });
    const planId = plan?.id ?? null;

    if (!planId) {
      logger.warn(
        { stripeSubId, productId: sub.productId },
        "billing: unknown product id, cannot sync subscription",
      );
      return; // Unknown plan; cannot upsert without referential integrity.
    }

    // Read the prior status before the upsert so we only emit on the edge
    // (status entering "canceled"), never on repeated syncs of an already-
    // canceled subscription.
    const existing = await tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.stripeSubscriptionId, sub.id),
      columns: { status: true },
    });
    canceledTransition =
      sub.status === "canceled" && existing?.status !== "canceled";

    const row = {
      orgId,
      planId,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: sub.customerId,
      // WHICH price this subscription is on. An identity, not an amount —
      // it recognises a subscription already sitting on the price being asked
      // for. The proration direction is measured by previewing the invoice
      // (#3157), never by comparing a stored figure.
      stripePriceId: sub.priceId,
      status: sub.status,
      billingInterval: sub.billingInterval,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canceledAt: sub.canceledAt,
      trialEnd: sub.trialEnd,
      seatCount: sub.seatCount,
    };

    await tx
      .insert(schema.subscriptions)
      .values(row)
      .onConflictDoUpdate({
        target: schema.subscriptions.stripeSubscriptionId,
        set: {
          planId: row.planId,
          stripePriceId: row.stripePriceId,
          status: row.status,
          billingInterval: row.billingInterval,
          currentPeriodStart: row.currentPeriodStart,
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          canceledAt: row.canceledAt,
          trialEnd: row.trialEnd,
          seatCount: row.seatCount,
          updatedAt: new Date(),
        },
      });

    logger.info(
      {
        orgId,
        stripeSubId,
        status: sub.status,
        durationMs: Date.now() - start,
      },
      "billing: subscription synced",
    );
  });

  // Provider-confirmed cancellation audit (system actor; no user session at the
  // webhook boundary). Fire-and-forget — never blocks the sync.
  if (canceledTransition) {
    emitSecurityEvent({
      eventType: "billing.subscription_canceled",
      actorUserId: null,
      orgId,
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    logger.info(
      { orgId, stripeSubId },
      "billing: subscription canceled (provider-confirmed) — audit emitted",
    );
  }
}

export async function cancelSubscription(
  stripeSubId: string,
  atPeriodEnd = true,
): Promise<void> {
  const provider = billingProvider();
  if (atPeriodEnd) {
    await provider.updateSubscription(stripeSubId, { cancelAtPeriodEnd: true });
  } else {
    await provider.cancelSubscription(stripeSubId);
  }
  await syncSubscriptionFromStripe(stripeSubId);
}

export async function reactivateSubscription(
  stripeSubId: string,
): Promise<void> {
  await billingProvider().updateSubscription(stripeSubId, {
    cancelAtPeriodEnd: false,
  });
  await syncSubscriptionFromStripe(stripeSubId);
}

/**
 * Cancel the active subscription for an organisation at period end.
 * Looks up the provider subscription id from our DB and delegates to
 * {@link cancelSubscription}. Raises if no active subscription is found.
 */
export async function cancelOrgSubscription(orgId: string): Promise<void> {
  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} in ('active','trialing')`,
      ),
      columns: { stripeSubscriptionId: true },
    }),
  );
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);
  logger.info(
    { orgId, stripeSubId: row.stripeSubscriptionId },
    "billing: cancelling org subscription at period end",
  );
  await cancelSubscription(row.stripeSubscriptionId, true);
}

/**
 * Undo a scheduled cancellation for the active subscription of an organisation.
 * Looks up the provider subscription id from our DB and delegates to
 * {@link reactivateSubscription}.
 */
export async function reactivateOrgSubscription(orgId: string): Promise<void> {
  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} in ('active','trialing','past_due')`,
      ),
      columns: { stripeSubscriptionId: true },
    }),
  );
  if (!row)
    throw new Error(`No cancellable subscription found for org ${orgId}`);
  logger.info(
    { orgId, stripeSubId: row.stripeSubscriptionId },
    "billing: reactivating org subscription",
  );
  await reactivateSubscription(row.stripeSubscriptionId);

  // SOC2 audit: a user undid a scheduled cancellation — a privileged billing
  // state change. Fire-and-forget — never blocks the reactivation.
  emitSecurityEvent({
    eventType: "billing.subscription_reactivated",
    actorUserId: null,
    orgId,
    workspaceId: null,
    capability: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
}

/**
 * Build the Stripe idempotency key for a plan change.
 *
 * The key identifies the INTENT, never the clock. It used to carry
 * `Math.floor(Date.now() / 10_000)`, on the reasoning that a 10-second window
 * dedupes a double-click while still allowing a deliberate later change. A
 * fixed bucket is the wrong shape for that: `floor(now / 10_000)` does not give
 * each submit a 10-second window, it gives the CLOCK fixed boundaries, and a
 * resubmit landing on the far side of one is treated as a new intent however
 * close the two clicks were. Measured, a 250 ms double-click produced two keys
 * — and therefore two proration invoices — for 2.5% of start offsets, and a
 * one-second client retry for 10% (#1421). `prorationBehavior` defaults to
 * `always_invoice`, so a duplicate is a duplicate INVOICE against a real
 * customer; both calls succeed, both reconcile to the same end state, and only
 * Stripe shows the second one.
 *
 * `setSubscriptionSeats` next door carries no clock either (see
 * {@link seatChangeIdempotencyKey}), and `autoreload.ts` reaches the same
 * conclusion the other way — it persists the key it charged under, because no
 * wall-clock derivation could survive a retry (#1420).
 *
 * Two guarantees, and the caller chooses which:
 *
 * - **With `requestId`** — the one the UI should send. Every submit of one
 *   intent carries one id, so a double-click or a client retry dedupes no
 *   matter how far apart the two land, and a deliberate later change to the
 *   same price carries a NEW id and is correctly not deduped.
 * - **Without it** — the key is the intent alone, so any repeat of the same
 *   change dedupes for as long as Stripe remembers the key (24 hours). This
 *   never fires a duplicate invoice, which is the failure that costs money. The
 *   cost is the other direction: switching to a different plan and back to this
 *   one inside 24 hours is deduped and does not apply. That is the trade the
 *   old comment claimed to have avoided and did not — it avoided it only away
 *   from bucket boundaries.
 */
export function planChangeIdempotencyKey(
  stripeSubId: string,
  newPriceId: string,
  requestId?: string,
): string {
  const base = `plan_change:${stripeSubId}:${newPriceId}`;
  return requestId ? `${base}:${requestId}` : base;
}

export async function upgradeSubscription(
  stripeSubId: string,
  newPriceId: string,
  prorationBehavior: "always_invoice" | "none" = "always_invoice",
  /**
   * Identifies THIS submit. Pass the client's request id so a double-click and
   * a deliberate later change are told apart — see
   * {@link planChangeIdempotencyKey} for what each choice guarantees.
   */
  requestId?: string,
  /**
   * The price the subscription was on when `prorationBehavior` was decided —
   * `BillingProrationPreview.billingPriceId`, off the same observation that
   * produced the decision.
   *
   * The swap refuses if the subscription has left it. Omit only when there is
   * no preview to bind to; the unpriceable case settles as `always_invoice`,
   * which is safe in either direction, and it is `none` that needs binding.
   */
  expectedCurrentPriceId?: string,
  /**
   * The second the preview priced this change at —
   * `BillingProrationPreview.prorationDate`, off the same observation that
   * produced `prorationBehavior`.
   *
   * Sent so the invoice this raises is computed from the instant the quoted
   * one was, rather than from whenever the provider happens to serve the
   * write. Omit only when there is no preview to take it from.
   */
  prorationDate?: number,
): Promise<void> {
  logger.info(
    {
      stripeSubId,
      newPriceId,
      prorationBehavior,
      expectedCurrentPriceId,
      prorationDate,
    },
    "billing: upgrading subscription price",
  );
  const idempotencyKey = planChangeIdempotencyKey(
    stripeSubId,
    newPriceId,
    requestId,
  );
  await billingProvider().upgradeSubscription(stripeSubId, {
    newPriceId,
    prorationBehavior,
    idempotencyKey,
    expectedCurrentPriceId,
    prorationDate,
  });
  await syncSubscriptionFromStripe(stripeSubId);
}

/**
 * Build the Stripe idempotency key for a seat change.
 *
 * The key names the transition, `prior->seats`, not only the target count. It
 * used to be `seats:${subId}:${seats}`. A change from 5 to 8 and back to 5
 * inside Stripe's 24-hour key window then reused the first `:5` key, Stripe
 * replayed the stored response, and the second change never applied (#2976).
 * The row still read 8 seats while the caller saw success.
 *
 * With the prior count in the key, 5->8 and 8->5 are different keys. A double
 * submit of one change still reads the same prior count, so it produces the
 * same key and Stripe dedupes it.
 *
 * `requestId` separates two deliberate submits of the same transition, the way
 * it does in {@link planChangeIdempotencyKey}. The key never carries a clock.
 */
export function seatChangeIdempotencyKey(
  stripeSubId: string,
  priorSeats: number,
  seats: number,
  requestId?: string,
): string {
  const base = `seats:${stripeSubId}:${priorSeats}->${seats}`;
  return requestId ? `${base}:${requestId}` : base;
}

/**
 * Update the seat count on an active subscription.
 *
 * Guard: if `seats` is less than the number of currently used seats
 * (active users + pending invitations), throws `SeatLimitError` — you
 * cannot drop below provisioned headcount.
 *
 * On success, updates the Stripe subscription item quantity (with immediate
 * proration invoicing) and syncs `seatCount` back to our DB.
 */
export async function setSubscriptionSeats(
  orgId: string,
  seats: number,
  opts: {
    /**
     * Identifies this submit. See {@link seatChangeIdempotencyKey} for what it
     * adds to the key.
     */
    requestId?: string;
  } = {},
): Promise<void> {
  if (seats < 1) throw new Error("seats must be >= 1");

  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} IN ('active','trialing')`,
      ),
      columns: { stripeSubscriptionId: true, seatCount: true },
    }),
  );
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);

  // Guard: cannot drop below current usage.
  if (seats < row.seatCount) {
    const usage = await getOrgSeatUsage(orgId);
    if (seats < usage.used) {
      throw new SeatLimitError(seats, usage.used);
    }
  }

  // Direction-aware proration: increases invoice immediately, decreases credit
  // on the next cycle (avoids surprising the customer with an immediate refund).
  const isIncrease = seats > row.seatCount;
  const prorationBehavior = isIncrease ? "always_invoice" : "create_prorations";
  const idempotencyKey = seatChangeIdempotencyKey(
    row.stripeSubscriptionId,
    row.seatCount,
    seats,
    opts.requestId,
  );

  logger.info(
    { orgId, seats, previous: row.seatCount, prorationBehavior },
    "billing: updating subscription seat count",
  );
  await billingProvider().setSubscriptionSeats(row.stripeSubscriptionId, {
    seats,
    prorationBehavior,
    idempotencyKey,
  });
  await syncSubscriptionFromStripe(row.stripeSubscriptionId);
}

/**
 * Change an org's plan to any other plan (any tier → any tier).
 *
 * The direction is decided by previewing the invoice the change would raise
 * and reading its sign — the actual money, discounts included, rather than any
 * stored or catalogued figure standing in for it. See
 * {@link planChangeDirection} for why every such stand-in has inverted.
 *
 * Bill rises (or cannot be priced): swap the price immediately and invoice the
 *   proration now.
 * Bill falls, or does not move: swap the price with proration_behavior 'none'
 *   — the new price applies from the next cycle and NO proration line is
 *   written, so the customer is not credited for the unused remainder of the
 *   plan they are leaving.
 *
 * If the org has NO active subscription (free tier), returns a Checkout
 * session URL for the new plan; the caller must redirect the user.
 * If one IS active, swaps the price in-place and returns null.
 *
 * Current seat count is preserved through a plan swap.
 */
/**
 * Write down which plan a change is moving away from, before the provider is
 * asked to move it.
 *
 * The prorated upgrade grant is sized from the allowance of the plan moved
 * FROM, and the swap destroys that: `upgradeSubscription` syncs the
 * subscription synchronously and the sync repoints `planId` at the target. A
 * call that died between those two points left a customer upgraded and
 * uncredited, and a retry had nothing left to recompute the grant from — the
 * row it would have read was already rewritten (#3157, PR #3171 review).
 *
 * This runs BEFORE any provider mutation deliberately. If it fails, nothing
 * has been swapped and nothing has been charged, so failing here is the
 * cheapest place in the operation to fail: the caller retries a plan change
 * that has not yet begun. Recording the intent after the swap would reopen the
 * exact window it exists to close.
 */
async function recordPlanUpgradeIntent(
  stripeSubscriptionId: string,
  fromPlanId: string,
): Promise<void> {
  await withTenantDb((tx) =>
    tx
      .update(schema.subscriptions)
      .set({ pendingUpgradeFromPlanId: fromPlanId, updatedAt: new Date() })
      .where(
        eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
      ),
  );
}

/**
 * Retire the intent once the grant it exists for has settled.
 *
 * Best-effort: a stale intent costs nothing. It is only ever read on the
 * already-applied branch, and the grant it would drive is idempotent on
 * (org, target plan, period) and delta-guarded, so re-running it grants
 * nothing a second time.
 */
async function clearPlanUpgradeIntent(
  stripeSubscriptionId: string,
): Promise<void> {
  try {
    await withTenantDb((tx) =>
      tx
        .update(schema.subscriptions)
        .set({ pendingUpgradeFromPlanId: null, updatedAt: new Date() })
        .where(
          eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
        ),
    );
  } catch (err) {
    logger.warn(
      { stripeSubId: stripeSubscriptionId, err },
      "billing: could not clear the plan-upgrade intent after its grant settled — harmless, the grant is idempotent",
    );
  }
}

/**
 * Which price the subscription is on **at the provider**, and on which
 * interval. The provider is the only source; there is no fallback to the local
 * record, for the reason set out below.
 *
 * `subscriptions.stripe_price_id` is written by `syncSubscriptionFromStripe`,
 * which runs AFTER the provider mutation. So the one failure the already-
 * applied guard exists to survive — a swap that reached Stripe and whose
 * response was lost — is exactly the one that can leave the local column
 * holding the old price. The retry then reads "not yet swapped", previews a
 * subscription that has already moved, measures no movement, and re-issues
 * the update as `none` under the idempotency key the first attempt used with
 * `always_invoice`. Stripe rejects a reused key whose parameters changed, so
 * every retry fails identically and the customer cannot get past it.
 *
 * The provider knows. Ask it. This is the same correction the rest of #3157
 * makes over and over: a local record of what happened is not what happened.
 *
 * AND THERE IS NO FALLBACK TO THE LOCAL ROW.
 *
 * There used to be, justified as: if the provider cannot be reached the swap
 * cannot be issued either, so refusing would trade a wrong answer for an
 * outage. That holds for an outage and not for a transient failure of THIS ONE
 * READ — the case where the preview and the update then succeed and the
 * operation runs on the very row this function exists to distrust. The
 * fallback therefore had no case in which it helped and one in which it
 * silently did harm, so it is gone: this raises
 * {@link SubscriptionStateUnavailableError} and the caller retries
 * (#3157, PR #3171 review).
 *
 * It is raised BEFORE any provider mutation and before the durable upgrade
 * intent is written, so a refusal leaves nothing half-done.
 *
 * THE PRICE ID IS ALL THIS RETURNS, AND THE INTERVAL DELIBERATELY IS NOT.
 *
 * It returned the interval too, for a good reason that stopped short of the
 * conclusion: `subscriptions.billing_interval` is written by the same
 * post-mutation sync, is stale in the same failure, and feeds a worse
 * decision — whether the change resets the billing-cycle anchor. True. But
 * answering it HERE meant the interval and the preview came from two separate
 * provider reads, and nothing holds two reads of one remote object together.
 * A plan update landing in between makes them describe different
 * subscriptions, and the decision they jointly feed is then made about neither
 * (#3157, PR #3171 review, r4042249142).
 *
 * The preview now carries the interval of the subscription it was computed
 * against ({@link BillingProrationPreview.billingInterval}), so this function
 * does not hand one out for anybody to compare it with. That is the point of
 * the narrowing rather than a side effect of it: a value nobody can obtain
 * here is a value that cannot disagree with the preview, whereas returning it
 * unused would leave the next caller a plausible-looking second source.
 *
 * What remains is the active price id, consumed BEFORE the preview is taken to
 * recognise a swap that has already been applied, and the active PRODUCT id.
 *
 * The product is not a second interval by another name, and the distinction is
 * the whole reason it is allowed back. The interval was removed because a
 * caller holding one could compare it against the preview's, and two readings
 * of one fact is the defect. The product answers a fact the preview does not
 * always carry: WHICH PLAN this subscription is moving from, which sizes the
 * prorated credit grant. When a preview exists, the preview's product is used
 * and this one is not consulted at all; this is reached only when no preview
 * could be taken, where the alternative is not a second opinion but no opinion
 * — and an earlier round of this branch established that a failed preview must
 * still grant the credits an upgrade earns, because withholding them was its
 * own defect (r4042477853).
 */
async function resolveActiveProviderState(
  stripeSubscriptionId: string,
): Promise<{ priceId: string | null; productId: string | null }> {
  try {
    const sub = await billingProvider().getSubscription(stripeSubscriptionId);
    return { priceId: sub.priceId, productId: sub.productId };
  } catch (err) {
    logger.warn(
      { stripeSubId: stripeSubscriptionId, err },
      "billing: could not read the provider's active price for a plan change — refusing to act on the last synced value",
    );
    throw new SubscriptionStateUnavailableError(stripeSubscriptionId);
  }
}

export async function changeOrgPlan(
  orgId: string,
  targetPlanSlug: string,
  interval: "month" | "year",
  opts?: {
    successUrl?: string;
    cancelUrl?: string;
    /**
     * Identifies this submit, so a double-click or a client retry is one
     * intent and a deliberate later change is another. Threaded to
     * {@link planChangeIdempotencyKey}; see it for what omitting it
     * guarantees.
     */
    requestId?: string;
    /**
     * The most this change was approved to charge now, in cents — the figure
     * a person was shown and agreed to.
     *
     * Checked against what the swap will actually collect, and the swap
     * refuses if it would cost more. Omit it only where no human approved an
     * amount; see {@link PlanChangeExceedsApprovedAmountError} for why it is
     * optional rather than required, and why absent does not mean unlimited.
     */
    approvedMaxCents?: number;
    /**
     * True when the preview this submit was made from answered
     * `requiresCheckout: true` — that is, when the caller believes this org
     * has no active subscription and is expecting a Stripe Checkout URL back.
     *
     * A claim about provider state, not a preference, and the state can move
     * between the preview and this call. If an active subscription is found,
     * the claim is false and the change is refused with
     * {@link PlanChangeCheckoutStateMovedError} rather than silently becoming
     * an in-place swap that charges a proration nobody approved.
     *
     * Absent and `false` both behave exactly as before. Only `true` refuses —
     * see the error for why absence is not, and cannot be, the discriminator.
     */
    previewRequiredCheckout?: boolean;
  },
): Promise<{ checkoutUrl: string } | null> {
  // billing.plans is a shared platform catalog (no org_id, RLS not enabled) —
  // read via withSystemDb to match the catalog-read convention used everywhere
  // else (public-plans.ts, subscription/page.tsx). billing.subscriptions IS
  // org-scoped under RLS, so it stays on withTenantDb.
  const [targetPlan, activeSubRow] = await Promise.all([
    withSystemDb((tx) =>
      tx.query.plans.findFirst({
        where: eq(schema.plans.slug, targetPlanSlug),
        columns: {
          id: true,
          slug: true,
          tier: true,
          stripePriceIdMonthly: true,
          stripePriceIdAnnual: true,
          // The proration decision is a price comparison, so the price has to
          // be selected alongside the price id it belongs to.
          monthlyCents: true,
          annualCents: true,
        },
      }),
    ),
    // billing.subscriptions IS org-scoped — keep it tenant-scoped under RLS.
    withTenantDb((tx) =>
      tx.query.subscriptions.findFirst({
        where: and(
          eq(schema.subscriptions.orgId, orgId),
          sql`${schema.subscriptions.status} IN ('active','trialing')`,
        ),
        columns: {
          stripeSubscriptionId: true,
          seatCount: true,
          planId: true,
          // The interval the org is billed on today. The change may move it,
          // and each side of the price comparison is priced on its own
          // interval.
          billingInterval: true,
          // Recognises a retry that lands on a subscription already swapped,
          // and dates the grant that retry has to check for.
          stripePriceId: true,
          currentPeriodStart: true,
          // The plan a change in flight is moving away from. Written before
          // the swap, because the swap destroys it: the sync inside
          // `upgradeSubscription` repoints `planId` at the target. It is what
          // lets a retry finish a grant the first attempt never reached.
          pendingUpgradeFromPlanId: true,
        },
      }),
    ),
  ]);

  if (!targetPlan) throw new Error(`Plan '${targetPlanSlug}' not found`);

  const newPriceId =
    interval === "year"
      ? targetPlan.stripePriceIdAnnual
      : targetPlan.stripePriceIdMonthly;
  if (!newPriceId)
    throw new Error(`Plan '${targetPlanSlug}' has no ${interval} price`);

  if (!activeSubRow) {
    // No active subscription — start a Checkout session.
    const { createCheckoutSession } = await import("./checkout");
    const result = await createCheckoutSession({
      orgId,
      planSlug: targetPlanSlug,
      interval,
      successUrl: opts?.successUrl,
      cancelUrl: opts?.cancelUrl,
    });
    logger.info(
      { orgId, targetPlanSlug, interval },
      "billing: changeOrgPlan — no active subscription, created checkout session",
    );
    return { checkoutUrl: result.url };
  }

  // ── The checkout this submit was priced as is no longer the change it is ──
  //
  // Everything below this line is the in-place path: it prorates, it invoices,
  // and it does so immediately. A submit that arrived asserting
  // `requiresCheckout` was priced against an org with no subscription, showed
  // no dialog and carries no approved figure, so nothing further down can
  // notice that it is now about to bill somebody — the approval gate is keyed
  // on an amount this path never had.
  //
  // So the refusal is here, in front of all of it, including the
  // already-applied early return below. That placement is deliberate rather
  // than convenient: the already-applied branch writes — it can resume a
  // credit grant and retire an intent — and a submit that did not know this
  // subscription existed is not the request that should be driving a repair of
  // it. The caller previews again and gets a change a person can approve
  // (#3157, PR #3171 review, r4042742296).
  if (opts?.previewRequiredCheckout === true) {
    logger.warn(
      {
        orgId,
        targetPlanSlug,
        interval,
        stripeSubId: activeSubRow.stripeSubscriptionId,
      },
      "billing: refusing a plan change priced as a checkout that would now be an in-place swap",
    );
    throw new PlanChangeCheckoutStateMovedError(
      activeSubRow.stripeSubscriptionId,
    );
  }

  // Resolve the plan the org is on now — for the log line and the audit
  // trail, NOT for the price comparison. Shared catalog (no RLS) → system.
  const currentPlanRow = await withSystemDb((tx) =>
    tx.query.plans.findFirst({
      where: eq(schema.plans.id, activeSubRow.planId),
      columns: { slug: true, tier: true },
    }),
  );

  // Already on the price being asked for — the swap has happened. This is the
  // retry of a call whose response was lost: re-issuing the update would
  // compare a subscription against its own current price, read "unchanged",
  // and send `none` where the first attempt sent `always_invoice`. Stripe
  // rejects a reused idempotency key whose parameters changed rather than
  // replaying the cached success, and the app action does not pass a
  // requestId, so the key is identical across the two attempts. Returning
  // here makes the retry the no-op it should be.
  //
  // Asked of the PROVIDER, not of our record of the provider — see
  // resolveActiveProviderState for why the local column is blind to exactly the
  // failure this guard exists for.
  const { priceId: activePriceId, productId: activeProductId } =
    await resolveActiveProviderState(activeSubRow.stripeSubscriptionId);

  if (activePriceId && activePriceId === newPriceId) {
    // ── Is this request resuming a mutation, or did nothing happen? ─────────
    //
    // ONE predicate, computed once here, gating BOTH the audit event and the
    // grant recovery below. They answer the same question, and two conditions
    // that have to agree is how the previous round of this went wrong.
    //
    // It is computed BEFORE the resync, deliberately: the evidence is the
    // state as this call found it, and the repair below is about to erase it.
    const recordedPriceId = activeSubRow.stripePriceId;

    // An intent is written before a swap and retired only once its grant has
    // settled, so a standing one is unfinished work from a real attempt.
    const hasStandingIntent = activeSubRow.pendingUpgradeFromPlanId !== null;

    // A recorded price that disagrees with the provider is a swap we never
    // wrote down. NULL is NOT that. `stripe_price_id` was added nullable with
    // no backfill (`20260917121000_subscription_billed_price.sql`), whose own
    // comment settles the reading: "rows written before this migration have
    // not been synced yet. The read path treats NULL as 'ask the provider',
    // never as zero." Treating it as a disagreement made this test a constant
    // for every subscription predating that column — the entire legacy
    // population — and reopened the false audit event for all of them
    // (#3157, PR #3171 review).
    //
    // It cannot be backfilled in SQL either, and must not be faked from the
    // catalogue: `billing.plans` holds today's price, while a grandfathered
    // subscriber sits on an older immutable one. Deriving the identity from
    // the plan row would write the wrong price id and reintroduce the exact
    // inversion this PR exists to remove. The column fills itself as
    // `syncSubscriptionFromStripe` runs — including from the repair below.
    const recordedPriceDisagrees =
      recordedPriceId !== null && recordedPriceId !== newPriceId;

    const resumesRealMutation = hasStandingIntent || recordedPriceDisagrees;

    // Repair the row whenever it does not match the provider — including the
    // NULL a pre-migration row carries, which is how that row stops being
    // legacy. Repairing is not evidence of anything; it is just repair.
    if (recordedPriceId !== newPriceId) {
      logger.warn(
        {
          orgId,
          stripeSubId: activeSubRow.stripeSubscriptionId,
          recordedPriceId,
          activePriceId,
        },
        recordedPriceId === null
          ? "billing: this subscription has never recorded which price it is on and the provider is already on the target — backfilling the row"
          : "billing: the provider has already applied this plan change but the local subscription row still holds the previous price — resyncing",
      );
      try {
        await syncSubscriptionFromStripe(activeSubRow.stripeSubscriptionId);
      } catch (err) {
        // The grant below keys on the period, which a failed resync leaves
        // stale — but the grant ledger dedupes on the fresh row it reads for
        // itself, so a stale period can only cause a redundant attempt.
        logger.error(
          { orgId, stripeSubId: activeSubRow.stripeSubscriptionId, err },
          "billing: could not resync a subscription the provider has already swapped; the local row stays stale",
        );
      }
    }

    // The audit row belongs to a mutation that HAPPENED — on this call or on a
    // previous attempt of it — and this branch is reached by two callers that
    // look identical from here.
    //
    // One is the retry the branch exists for: the first attempt's swap reached
    // Stripe and its response was lost. That request really did perform a
    // privileged billing mutation, and because the first attempt never got to
    // say so, this event is the only record of it. It must be emitted.
    //
    // The other is somebody submitting the plan and interval they are already
    // on. Nothing is mutated, and `billing.plan_changed` would assert a
    // privileged mutation that never occurred. False SOC 2 evidence is worse
    // than absent evidence: absent evidence is a gap, false evidence has to be
    // disproved before anyone can trust the rest of the trail (#3157, PR #3171
    // review).
    //
    // The two are told apart by `resumesRealMutation`, computed at the top of
    // this branch from state already on the row. Steady state has neither
    // piece of evidence: the row agrees with the provider and nothing is in
    // flight.
    //
    // KNOWN GAP, carried rather than half-fixed. This infers "no audit event
    // was written" from grant and sync state, which does not entail it: a
    // first attempt whose swap and emission both succeeded and whose GRANT
    // then failed leaves the intent standing, so the retry emits a second
    // event for one mutation. Answering that honestly means recording the
    // emission durably — a column on the intent, and a migration — which is
    // the same row #3244 already has to add for the resumed grant's proration
    // point. Inventing a half-durable version here would be a fourth stand-in
    // for a fact nobody recorded, which is the argument this PR is built on.
    if (resumesRealMutation) {
      emitSecurityEvent({
        eventType: "billing.plan_changed",
        actorUserId: null,
        orgId,
        workspaceId: null,
        capability: null,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: null,
      });
    }

    // The swap is a no-op on a retry; the prorated credit grant is not. If the
    // first attempt died between the two, the customer is on the new plan
    // without the included credits that came with it, and nothing about the
    // provider state says so — which is why the credit ledger is asked
    // directly rather than inferred.
    //
    // The grant's size depends on the allowance of the plan moved FROM, and
    // `syncSubscriptionFromStripe` has already repointed this row at the
    // target, so `planId` cannot supply it. `pendingUpgradeFromPlanId` can:
    // it was written before the swap for exactly this moment, and the sync
    // does not touch it. With it, the retry finishes the job instead of
    // reporting a job it did not finish.
    //
    // Gated on the SAME `resumesRealMutation` the audit event is, because the
    // question is the same one. Asking the ledger whether an upgrade grant
    // landed, for an upgrade that never happened, finds nothing and takes the
    // `else` below — an error telling an operator to repair credits by hand.
    // `hasPlanUpgradeGrant` matches only `GRANT_PLAN_UPGRADE`, which
    // `grantProratedPlanUpgradeCredits` alone ever writes; a subscription
    // created through Checkout is credited under `GRANT_PLAN_RENEWAL` by
    // `grantPlanCreditsForInvoicePaid`. So every subscription never upgraded
    // in place raised that alarm on every same-plan submission (#3157,
    // PR #3171 review).
    if (!resumesRealMutation) {
      logger.info(
        { orgId, targetPlanSlug, interval, newPriceId },
        "billing: changeOrgPlan — already on this plan and nothing in flight; no mutation, so no audit event and no grant to recover",
      );
      return null;
    }

    try {
      const granted = await hasPlanUpgradeGrant(
        orgId,
        targetPlan.id,
        activeSubRow.currentPeriodStart,
      );
      const fromPlanId = activeSubRow.pendingUpgradeFromPlanId;
      if (granted) {
        // Nothing left owed on this move; retire the intent.
        if (fromPlanId) {
          await clearPlanUpgradeIntent(activeSubRow.stripeSubscriptionId);
        }
      } else if (fromPlanId) {
        const { grantProratedPlanUpgradeCredits } = await import("./grants");
        await grantProratedPlanUpgradeCredits(orgId, fromPlanId, targetPlan.id);
        await clearPlanUpgradeIntent(activeSubRow.stripeSubscriptionId);
        logger.info(
          { orgId, targetPlanSlug, fromPlanId, toPlanId: targetPlan.id },
          "billing: resumed the prorated credit grant for a plan change whose swap had already been applied",
        );
      } else {
        // No intent recorded — the swap predates this column, or the intent
        // was already retired and the ledger disagrees. Nothing is
        // recoverable in code; say so at error level rather than report the
        // operation complete.
        logger.error(
          { orgId, targetPlanSlug, targetPlanId: targetPlan.id, newPriceId },
          "billing: plan change was already applied but its prorated credit grant is missing and no origin plan was recorded for it; grant needs manual repair",
        );
      }
    } catch (err) {
      logger.error(
        { orgId, targetPlanSlug, err },
        "billing: could not determine whether the prorated credit grant landed for an already-applied plan change",
      );
    }

    logger.info(
      { orgId, targetPlanSlug, interval, newPriceId },
      "billing: changeOrgPlan — subscription is already on the target price, nothing to swap",
    );
    return null;
  }

  // Active subscription — swap the price in-place. Proration follows the money
  // the change will actually move.
  //
  // What goes in is the interval being ASKED FOR. The interval being moved
  // from is measured inside, off the preview's own subscription read, so the
  // comparison cannot straddle two different readings of one subscription —
  // see planChangeDirection.
  const { prorationBehavior, direction, amountCents, preview } =
    await planChangeDirection(
      activeSubRow.stripeSubscriptionId,
      newPriceId,
      interval,
    );
  // ── What the customer agreed to pay, honoured ────────────────────────
  //
  // The quote is computed by a different call, on the other side of an HTTP
  // round trip and a dialog somebody may leave open. This is the only thing
  // that ties the number they read to the charge they get: everything else
  // here binds provider state to provider state, and no amount of that can
  // notice that a discount expired while a person was deciding.
  //
  // Derived exactly as `previewPlanChange` derives the figure it shows — the
  // same expression, so the two cannot drift into disagreeing about what
  // "charged now" means. A behaviour of `none` writes no proration line, so
  // nothing is collected at the swap however large the previewed credit.
  if (opts?.approvedMaxCents !== undefined) {
    const chargedNowCents =
      amountCents === null
        ? null
        : prorationBehavior === "always_invoice"
          ? amountCents
          : 0;
    if (chargedNowCents === null || chargedNowCents > opts.approvedMaxCents) {
      logger.warn(
        {
          orgId,
          targetPlanSlug,
          interval,
          approvedMaxCents: opts.approvedMaxCents,
          chargedNowCents,
          priceDirection: direction,
          prorationBehavior,
        },
        "billing: refusing a plan change that would charge more than was approved",
      );
      throw new PlanChangeExceedsApprovedAmountError(
        opts.approvedMaxCents,
        chargedNowCents,
      );
    }
  }

  // Reported, never used to decide the credit grant. Whether the customer owes
  // money and whether their included allowance went up are different
  // questions, and this one answers only the first — see the grant below.
  const billsMoreNow =
    direction === "increase" || direction === "interval_change";

  // Use activeSubRow from now on (renamed to avoid confusion).
  const activeSub = activeSubRow;

  logger.info(
    {
      orgId,
      targetPlanSlug,
      interval,
      currentTier: currentPlanRow?.tier,
      targetTier: targetPlan.tier,
      // The interval of the subscription the preview priced — the one the
      // decision was actually made against, not a separate reading of it.
      previewedInterval: preview?.billingInterval ?? null,
      // What the local column said, logged beside it so a row drifting from
      // the provider is visible here rather than only in its consequences.
      recordedInterval: activeSubRow.billingInterval,
      previewedProrationCents: amountCents,
      // The invoice, and what will actually be collected off it. They differ
      // by the customer's account balance, and only the second is the charge.
      previewedInvoiceTotalCents: preview?.totalCents ?? null,
      collectibleCents: preview?.amountDueCents ?? null,
      priceDirection: direction,
      billsMoreNow,
      prorationBehavior,
    },
    "billing: changeOrgPlan — swapping price on active subscription",
  );

  // ── The plan being moved FROM, asked of the state the preview priced ─────
  //
  // This decides the size of the prorated credit grant, and it used to be
  // `activeSub.planId` — the LOCAL row, written by the post-mutation sync, and
  // therefore stale in precisely the failure the already-applied guard exists
  // for. A subscription the provider already moved Build→Scale whose sync was
  // lost still reads Build here, so a Scale→Enterprise change is granted the
  // Build→Enterprise delta: the customer is credited for an allowance step
  // they already had (r4042477853).
  //
  // The preview's subscription is the provider's own answer, on the single
  // observation the direction came from. The PRODUCT rather than the price,
  // because a grandfathered subscriber sits on an immutable old price that no
  // catalogue row carries, while the product is exactly what
  // `syncSubscriptionFromStripe` already maps to a plan.
  // The preview's product when there is a preview — the same single observation
  // the direction came from. When there is not, the provider-state read taken
  // above, which is the only other place the PROVIDER has spoken. Never
  // `activeSub.planId`: the local row is the thing this finding is about.
  //
  // This is a fallback, not a second opinion: exactly one of the two is
  // consulted, chosen by whether a preview exists at all.
  const previewedProductId = preview
    ? preview.billingProductId
    : activeProductId;
  const originPlanRow = previewedProductId
    ? await withSystemDb((tx) =>
        tx.query.plans.findFirst({
          where: eq(schema.plans.stripeProductId, previewedProductId),
          columns: { id: true },
        }),
      )
    : null;
  const originPlanId = originPlanRow?.id ?? null;
  if (originPlanId !== activeSub.planId) {
    logger.warn(
      {
        orgId,
        stripeSubId: activeSub.stripeSubscriptionId,
        recordedPlanId: activeSub.planId,
        previewedProductId,
        previewedOriginPlanId: originPlanId,
      },
      "billing: the plan this change moves from, as the provider priced it, is not the plan the local row records",
    );
  }

  // Durable intent, written before the provider is touched. `upgradeSubscription`
  // syncs the subscription synchronously and that sync repoints `planId` at
  // the target, so from this line on the plan being left exists nowhere else.
  // A crash between the swap and the grant is what this is for: the retry
  // reads it on the already-applied branch above and finishes the grant.
  //
  // It records the PROVIDER's origin for the same reason the grant uses it:
  // an intent carrying the stale row would hand the retry the wrong delta,
  // which is the defect above surviving a crash.
  if (originPlanId) {
    await recordPlanUpgradeIntent(activeSub.stripeSubscriptionId, originPlanId);
  }

  // Binds the mutation to the state the origin information came from.
  //
  // With a preview, that is the subscription the preview priced. WITHOUT one it
  // is the provider-state read above — and that case was left unbound in the
  // round that introduced this, on the reasoning that an unpriceable change
  // settles as `always_invoice`, which bills the true difference either way, so
  // refusing would trade a safe outcome for an outage.
  //
  // That reasoning was wrong, and specifically it conflated a failed PREVIEW
  // with an unavailable PROVIDER. This path is only reachable when
  // `getSubscription` SUCCEEDED — a failure there raises
  // SubscriptionStateUnavailableError long before the preview — and only
  // `previewPlanChange` failed. In a real outage execution never arrives here,
  // so binding costs nothing to an outage; it refuses only when the
  // subscription has genuinely moved.
  //
  // And the charge being safe was never the whole story. `always_invoice` bills
  // the true difference for whatever transition actually happens, but the
  // CREDIT GRANT is sized from `activeProductId`, read before the preview. A
  // plan change landing in between meant the swap correctly invoiced B→C while
  // the grant was sized A→C, over- or under-granting included credits
  // (#3157, PR #3171 review, r4042603495).
  //
  // Binding here settles that without a second source: a Stripe price belongs
  // immutably to one product, so a mutation that confirms the price is
  // unchanged confirms the product is too. The origin is bound by construction
  // rather than re-read.
  //
  // `activePriceId` null leaves it unbound, but `activeProductId` is then null
  // as well, so the origin cannot be established at all and the grant is
  // skipped by the branch below. No new hole.
  const expectedCurrentPriceId =
    preview?.billingPriceId ?? activePriceId ?? undefined;
  try {
    await upgradeSubscription(
      activeSub.stripeSubscriptionId,
      newPriceId,
      prorationBehavior,
      opts?.requestId,
      expectedCurrentPriceId,
      // The anchor the behaviour and the approved figure were both computed
      // at. Without it Stripe re-anchors at write time and the invoice is not
      // the one the approval gate just checked (review 5243042193).
      preview?.prorationDate,
    );
  } catch (err) {
    // The intent was written a moment ago for a swap that then did not happen.
    // This one error is raised BEFORE the provider is mutated, so it is the
    // only failure here where nothing having been applied is certain — every
    // other one may have landed, and clearing on those would destroy a real
    // intent whose grant is still owed.
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "SUBSCRIPTION_MOVED_SINCE_PREVIEW"
    ) {
      await clearPlanUpgradeIntent(activeSub.stripeSubscriptionId);
    }
    throw err;
  }

  // SOC2 audit: an org's plan tier changed on an active subscription (upgrade
  // OR downgrade) — a privileged billing mutation. The no-active-sub branch
  // above returns a Checkout URL and does NOT change a plan in place, so it is
  // not emitted here (the resulting checkout.session.completed webhook syncs a
  // brand-new subscription). Fire-and-forget — never blocks the swap.
  emitSecurityEvent({
    eventType: "billing.plan_changed",
    actorUserId: null,
    orgId,
    workspaceId: null,
    capability: null,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });

  // Preserve seat count: if current seatCount > 1, update the quantity after
  // the price swap. upgradeSubscription keeps the same item, so quantity persists
  // through the price swap automatically — no extra call needed.

  // Offer every completed swap to the grant, and let the grant decide.
  //
  // This used to run only when the previewed invoice said the bill went up,
  // which conflated two questions. `planChangeDirection` answers *does the
  // customer owe money now*; the grant answers *did the included allowance go
  // up*, from `toPlan.includedCreditCents - fromPlan.includedCreditCents`. A
  // preview that could not be taken returns `direction: "unknown"`, which is
  // not an answer to either — and gating on it meant a transient provider
  // blip followed by a successful Build→Scale swap charged the customer and
  // withheld the credits, then cleared the durable intent so the retry path
  // could not repair it. The mechanism built this round was walked around by
  // the one branch it was built for (#3157, PR #3171 review).
  //
  // The grant is delta-guarded (`delta <= 0` returns without granting) and
  // idempotent on (org, target plan, period), so handing it a downgrade or a
  // lateral move costs one catalogue read and grants nothing. The fact that
  // decides is the delta, so the delta is what is consulted.
  //
  // Sized from `originPlanId`, the provider's own answer — never the local
  // row. When the preview could not name it (no preview, or a product no
  // catalogue row carries), the grant is SKIPPED rather than sized from the
  // stale column: granting from a source known to be wrong sends credits out
  // of the door. An unknown is not a nothing, which is the rule the rest of
  // this change is built on.
  //
  // WHAT SKIPPING LEAVES BEHIND, STATED HONESTLY. It leaves a loud log and
  // nothing else. There is NO standing intent in this case, because
  // `recordPlanUpgradeIntent` above sits behind the same `originPlanId` check
  // that skips the grant here — an intent is a plan foreign key, and a product
  // no catalogue row carries cannot produce one. Once the sync lands, the
  // provider and the local row agree on the price and no intent stands, so a
  // retry reads it as steady state and does nothing. These credits are not
  // recoverable in code; they need an operator.
  //
  // This log used to say the intent was "left standing for repair", which sent
  // whoever read it looking for a record that was never written. Making the
  // case genuinely recoverable needs somewhere durable to keep a
  // PROVIDER-ORIGIN product, or a refusal of the swap itself — and refusing
  // would block a grandfathered subscriber from changing plan at all. Both are
  // larger than this change; saying what is true is not (r4042794577).
  let grantSettled = false;
  if (!originPlanId) {
    logger.error(
      {
        orgId,
        targetPlanSlug,
        previewedProductId,
        recordedPlanId: activeSub.planId,
      },
      "billing: the plan this change moved from could not be established from the provider, so the prorated credit grant was not sized and no upgrade intent could be recorded for it; the grant needs manual repair",
    );
  } else {
    try {
      const { grantProratedPlanUpgradeCredits } = await import("./grants");
      await grantProratedPlanUpgradeCredits(orgId, originPlanId, targetPlan.id);
      grantSettled = true;
    } catch (err) {
      // Grant failure must never fail the plan swap — log and continue. The
      // intent is deliberately left standing so the grant is recoverable.
      logger.error(
        { orgId, fromPlanId: originPlanId, toPlanId: targetPlan.id, err },
        "billing: grantProratedPlanUpgradeCredits failed after plan swap — continuing; the recorded upgrade intent is left in place so a retry can finish it",
      );
    }
  }
  if (grantSettled) {
    await clearPlanUpgradeIntent(activeSub.stripeSubscriptionId);
  }

  return null;
}

// ── SeatChangePreview ─────────────────────────────────────────────────────────

export interface SeatChangePreview {
  currentSeats: number;
  requestedSeats: number;
  direction: "increase" | "decrease" | "none";
  amountCents: number; // >0 = charge now; <0 = credit next cycle
  isCharge: boolean;
  isCredit: boolean;
  currency: string;
  /** The default card that WOULD be charged; null if none on file. */
  card: { brand: string | null; last4: string | null } | null;
  prorationDate: number;
  /** Present when seats < current usage (decrease blocked by headcount). */
  blocked?: {
    code: "seat_limit_reached";
    licenses: number;
    used: number;
  };
}

/**
 * Simulate a seat-count change and return what WOULD be charged/credited —
 * without applying it. Drives the confirm-before-charge UI step.
 *
 * - direction increase: proration 'always_invoice' (charge now).
 * - direction decrease: proration 'create_prorations' (credit next cycle).
 * - direction none: returns amountCents=0 immediately (no provider call needed).
 * - Decrease below current usage: returns `blocked` instead of throwing.
 */
export async function previewSeatChange(
  orgId: string,
  seats: number,
): Promise<SeatChangePreview> {
  const start = Date.now();
  if (seats < 1) throw new Error("seats must be >= 1");

  const row = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} IN ('active','trialing')`,
      ),
      columns: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        seatCount: true,
      },
    }),
  );
  if (!row) throw new Error(`No active subscription found for org ${orgId}`);

  const currentSeats = row.seatCount;
  const direction: "increase" | "decrease" | "none" =
    seats > currentSeats
      ? "increase"
      : seats < currentSeats
        ? "decrease"
        : "none";

  // No-change path — no provider call needed.
  if (direction === "none") {
    logger.debug({ orgId, seats }, "billing: previewSeatChange — no change");
    return {
      currentSeats,
      requestedSeats: seats,
      direction: "none",
      amountCents: 0,
      isCharge: false,
      isCredit: false,
      currency: "usd",
      card: null,
      prorationDate: Math.floor(Date.now() / 1000),
    };
  }

  // Decrease guard: if seats < current usage, return blocked (do NOT throw).
  if (direction === "decrease") {
    const usage = await getOrgSeatUsage(orgId);
    if (seats < usage.used) {
      logger.warn(
        { orgId, requestedSeats: seats, used: usage.used },
        "billing: previewSeatChange — decrease blocked by seat usage",
      );
      return {
        currentSeats,
        requestedSeats: seats,
        direction: "decrease",
        amountCents: 0,
        isCharge: false,
        isCredit: false,
        currency: "usd",
        card: null,
        prorationDate: Math.floor(Date.now() / 1000),
        blocked: {
          code: "seat_limit_reached",
          licenses: usage.licenses,
          used: usage.used,
        },
      };
    }
  }

  const prorationBehavior =
    direction === "increase" ? "always_invoice" : "create_prorations";

  const preview = await billingProvider().previewSeatChange(
    row.stripeSubscriptionId,
    { seats, prorationBehavior },
  );

  // Resolve default card details for the confirmation step.
  let card: { brand: string | null; last4: string | null } | null = null;
  try {
    const provider = billingProvider();
    const defaultPmId = await provider.getDefaultPaymentMethodId(
      row.stripeCustomerId,
    );
    if (defaultPmId) {
      const methods = await provider.listPaymentMethods(row.stripeCustomerId);
      const pm = methods.find((m) => m.id === defaultPmId);
      if (pm) card = { brand: pm.brand, last4: pm.last4 };
    }
  } catch (err) {
    logger.warn(
      { orgId, err },
      "billing: could not resolve default card for seat preview",
    );
  }

  logger.info(
    {
      orgId,
      currentSeats,
      requestedSeats: seats,
      direction,
      amountCents: preview.amountCents,
      durationMs: Date.now() - start,
    },
    "billing: seat change preview computed",
  );

  return {
    currentSeats,
    requestedSeats: seats,
    direction,
    amountCents: preview.amountCents,
    isCharge: preview.isCharge,
    isCredit: preview.amountCents < 0,
    currency: preview.currency,
    card,
    prorationDate: preview.prorationDate,
  };
}

// ── PlanChangePreview ─────────────────────────────────────────────────────────

export interface PlanChangePreview {
  targetPlanSlug: string;
  interval: "month" | "year";
  amountCents: number;
  isCharge: boolean;
  currency: string;
  /** The default card that WOULD be charged; null if none on file. */
  card: { brand: string | null; last4: string | null } | null;
  prorationDate: number;
  /**
   * True when the org has no active subscription — the upgrade MUST go through
   * Stripe Checkout rather than an in-place price swap.
   */
  requiresCheckout: boolean;
}

/**
 * Simulate a plan change and return what WOULD be charged/credited.
 *
 * - No active subscription: requiresCheckout=true, amountCents = full plan price.
 * - Active subscription, bill rises: proration 'always_invoice'.
 * - Active subscription, bill falls or holds: proration 'none' (no immediate
 *   charge).
 *
 * The direction is the same price comparison {@link changeOrgPlan} makes, from
 * the same helpers, against the same subscription price. It has to be: this
 * preview is the number the customer is shown before they confirm, and a
 * preview computed under one proration flag while the change applies another
 * quotes a price the change will not honour. That equally covers the
 * grandfathered case — a subscriber kept on an old price after a catalogue
 * reprice must not be previewed against the new catalogue figure and then
 * billed against their own (#3157).
 */
export async function previewPlanChange(
  orgId: string,
  targetPlanSlug: string,
  interval: "month" | "year",
): Promise<PlanChangePreview> {
  const start = Date.now();

  // billing.plans is a shared platform catalog (no org_id, RLS not enabled) →
  // read via withSystemDb; billing.subscriptions is org-scoped → withTenantDb.
  const [targetPlan, activeSub] = await Promise.all([
    withSystemDb((tx) =>
      tx.query.plans.findFirst({
        where: eq(schema.plans.slug, targetPlanSlug),
        columns: {
          id: true,
          slug: true,
          tier: true,
          stripePriceIdMonthly: true,
          stripePriceIdAnnual: true,
          monthlyCents: true,
          annualCents: true,
        },
      }),
    ),
    withTenantDb((tx) =>
      tx.query.subscriptions.findFirst({
        where: and(
          eq(schema.subscriptions.orgId, orgId),
          sql`${schema.subscriptions.status} IN ('active','trialing')`,
        ),
        columns: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          planId: true,
          billingInterval: true,
        },
      }),
    ),
  ]);

  if (!targetPlan) throw new Error(`Plan '${targetPlanSlug}' not found`);

  const newPriceId =
    interval === "year"
      ? targetPlan.stripePriceIdAnnual
      : targetPlan.stripePriceIdMonthly;
  if (!newPriceId) {
    throw new Error(`Plan '${targetPlanSlug}' has no ${interval} price`);
  }

  // Full plan price for checkout scenario.
  // `annualCents` is nullable in the DB schema (plans with no annual price have
  // annualCents = null). Falling back to monthlyCents when annualCents is null
  // would quote the customer the monthly price (~10× too low) while Stripe charges
  // the actual annual price — a deceptive UI and chargeback risk.
  // Throw explicitly so misconfigured plans are caught before any checkout session
  // is created rather than silently misleading the customer.
  if (interval === "year" && targetPlan.annualCents === null) {
    throw new Error(
      `Plan '${targetPlanSlug}' has no annualCents configured; cannot preview annual subscription price`,
    );
  }
  const fullPriceCents =
    interval === "year"
      ? (targetPlan.annualCents as number)
      : targetPlan.monthlyCents;

  // Helper: resolve default card.
  async function resolveDefaultCard(
    customerId: string,
  ): Promise<{ brand: string | null; last4: string | null } | null> {
    try {
      const provider = billingProvider();
      const defaultPmId = await provider.getDefaultPaymentMethodId(customerId);
      if (!defaultPmId) return null;
      const methods = await provider.listPaymentMethods(customerId);
      const pm = methods.find((m) => m.id === defaultPmId);
      return pm ? { brand: pm.brand, last4: pm.last4 } : null;
    } catch (err) {
      logger.warn(
        { orgId, err },
        "billing: could not resolve default card for plan preview",
      );
      return null;
    }
  }

  if (!activeSub) {
    // No active subscription → Checkout path. Use the full plan price.
    // Resolve the customer id for card lookup (may not exist yet).
    let card: { brand: string | null; last4: string | null } | null = null;
    try {
      const customerId = await resolveCustomerId(orgId);
      card = await resolveDefaultCard(customerId);
    } catch (err) {
      // resolveCustomerId either returns a customer id or throws (there is no
      // distinguishable "not found" signal — ensureStripeCustomer creates the
      // customer or fails on a real Stripe error). So we can't cleanly separate
      // the expected "no customer yet" case from an auth/outage/rate-limit
      // incident. Log every caught error rather than silently claiming "no card
      // on file" during an outage, but preserve the no-card fallback so the
      // preview still renders.
      logger.warn(
        { orgId, err },
        "billing: plan-change preview card lookup failed — proceeding as no card",
      );
    }

    const prorationDate = Math.floor(Date.now() / 1000);

    logger.info(
      {
        orgId,
        targetPlanSlug,
        interval,
        requiresCheckout: true,
        durationMs: Date.now() - start,
      },
      "billing: plan change preview — no active sub, checkout required",
    );

    return {
      targetPlanSlug,
      interval,
      amountCents: fullPriceCents,
      isCharge: true,
      currency: "usd",
      card,
      prorationDate,
      requiresCheckout: true,
    };
  }

  // Active subscription — in-place swap preview. Shared catalog (no RLS) → system.
  // No current-plan lookup here. The preview needs what the subscriber is
  // billed, which the subscription carries, and the plan row behind it would
  // only reintroduce the catalogue figure this path must not read (#3157).
  //
  // ONE PROVIDER READ, AND IT IS THE PREVIEW.
  //
  // This used to take its own `getSubscription` here, purely to learn the
  // interval being moved from, and hand the comparison to
  // `planChangeDirection` as a boolean. That is two reads of one remote
  // object inside one quote, with nothing holding them together: a plan
  // update landing between them makes the boolean describe the subscription
  // before it and the preview describe the subscription after it. Read says
  // monthly, preview is computed on annual, this request asks for monthly —
  // the comparison scores same-interval, the annual→monthly credit reads as a
  // downgrade, `none` is selected, and the screen quotes $0 while the swap
  // that follows resets the anchor and invoices the whole new month.
  //
  // It is the identical defect the swap path carried, on the path that is
  // strictly worse to get wrong: this number is the one a person reads before
  // pressing the button (#3157, PR #3171 review, r4042249142).
  //
  // So nothing is read here. The interval moved TO is `interval`, a request
  // parameter with no staleness to have, and the interval moved FROM comes
  // back on the preview, off the same provider request that priced it.
  //
  // Losing the separate read does not lose the refusal it used to provide: a
  // provider that cannot be reached cannot produce a preview either, and the
  // null amount that follows throws PlanChangePreviewUnavailableError below.
  // What it does lose is the case where only that extra call failed — and
  // there the quote is now simply correct, computed from the subscription the
  // preview priced, rather than refused.
  //
  // One preview answers both questions: which way the money moves, and how
  // much of it moves now. Taken exactly as changeOrgPlan takes it, because a
  // preview computed from one measure while the change bills against another
  // quotes a price the change will not honour (#3157).
  const { prorationBehavior, direction, amountCents, preview } =
    await planChangeDirection(
      activeSub.stripeSubscriptionId,
      newPriceId,
      interval,
    );
  // Log only. Not a statement about credits — see the grant in changeOrgPlan.
  const billsMoreNow =
    direction === "increase" || direction === "interval_change";

  // No preview, no quote. `changeOrgPlan` may settle an unknown direction as
  // always_invoice because the provider bills the true difference either way;
  // this path cannot, because it is answering a person who is about to press
  // a button. Coercing null to 0 here promised "nothing to pay" and then let
  // always_invoice charge the real amount.
  if (amountCents === null) {
    throw new PlanChangePreviewUnavailableError(activeSub.stripeSubscriptionId);
  }

  // What the customer is actually asked for now. A same-interval change that
  // does not raise the bill ships `none`, which writes no proration line, so
  // nothing is owed at the moment of the swap however large the previewed
  // credit was. An interval change always owes its invoice.
  const chargedNowCents =
    prorationBehavior === "always_invoice" ? amountCents : 0;

  const card = await resolveDefaultCard(activeSub.stripeCustomerId);

  logger.info(
    {
      orgId,
      targetPlanSlug,
      interval,
      // The interval of the subscription the preview priced — the one the
      // quote was actually computed against, not a separate reading of it.
      previewedInterval: preview?.billingInterval ?? null,
      // What the local column said, logged beside it so a row drifting from
      // the provider is visible here rather than only in its consequences.
      recordedInterval: activeSub.billingInterval,
      previewedProrationCents: amountCents,
      previewedInvoiceTotalCents: preview?.totalCents ?? null,
      collectibleCents: preview?.amountDueCents ?? null,
      priceDirection: direction,
      billsMoreNow,
      amountCents: chargedNowCents,
      requiresCheckout: false,
      durationMs: Date.now() - start,
    },
    "billing: plan change preview computed",
  );

  return {
    targetPlanSlug,
    interval,
    amountCents: chargedNowCents,
    isCharge: chargedNowCents > 0,
    currency: preview?.currency ?? "usd",
    card,
    prorationDate: preview?.prorationDate ?? Math.floor(Date.now() / 1000),
    requiresCheckout: false,
  };
}

// ── Internal helper used by previewPlanChange ────────────────────────────────

async function resolveCustomerId(orgId: string): Promise<string> {
  const recorded = await readRecordedCustomerId(orgId);
  if (recorded) return recorded;
  const { ensureStripeCustomer } = await import("./customers");
  return ensureStripeCustomer(orgId);
}
