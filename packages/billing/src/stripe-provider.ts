/**
 * stripe-provider.ts — Stripe SDK implementation of BillingProvider.
 *
 * This file is the ONLY place in the billing package that imports from the
 * `stripe` package. All other files use the BillingProvider interface from
 * provider.ts. Swap this file (or the singleton in client.ts) to replace the
 * vendor without touching business logic.
 */

import Stripe from "stripe";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import { providerPeriodSeconds } from "./invoice-copy";
import type {
  BillingCreditPackLineItem,
  BillingCheckoutDynamicCreditInput,
  BillingCheckoutGauInput,
  BillingCheckoutPaymentInput,
  BillingCheckoutPaymentMethod,
  BillingCheckoutResult,
  BillingCheckoutSession,
  BillingCheckoutSubscriptionInput,
  BillingCustomerCreateInput,
  BillingCustomerSearchResult,
  BillingDispute,
  BillingDraftInvoiceOutcome,
  BillingGauInvoiceInput,
  BillingGauInvoicePayment,
  BillingGauInvoiceRef,
  BillingInvoice,
  BillingInvoiceLineItem,
  BillingOffSessionChargeInput,
  BillingOffSessionChargeResult,
  BillingPaymentMethod,
  BillingPrepaidInvoiceInput,
  BillingPrepaidInvoiceRef,
  BillingPrepaidInvoiceState,
  BillingPrepaidOrderRef,
  BillingPlanPreviewInput,
  BillingProrationPreview,
  BillingProvider,
  BillingRefundedCharge,
  BillingSeatPreviewInput,
  BillingSetupIntent,
  BillingSubscription,
  BillingSubscriptionSeatUpdateInput,
  BillingSubscriptionStatus,
  BillingSubscriptionUpdateInput,
  BillingSubscriptionUpgradeInput,
  BillingWebhookEvent,
  BillingWebhookEventType,
} from "./provider";
import {
  AmbiguousProrationAnchorError,
  PreviewedSubscriptionUnavailableError,
  SimulatedPreviewSubscriptionError,
  SubscriptionMovedError,
  ProrationAttributionError,
  ProrationLinesTruncatedError,
} from "./provider";

/** Wrap an optional Stripe idempotency key into request options. */
function idempotency(
  key: string | undefined,
): Stripe.RequestOptions | undefined {
  return key ? { idempotencyKey: key } : undefined;
}

/** Whether automatic tax calculation (Stripe Tax) is enabled for this account. */
function automaticTaxEnabled(): boolean {
  // Gated by env so the code path is complete and ships dark until Stripe Tax
  // is activated in the dashboard (a true external action). Flip
  // STRIPE_TAX_ENABLED=true once registered.
  return process.env.STRIPE_TAX_ENABLED === "true";
}

/**
 * Reduce a previewed invoice down to the net proration of the simulated change.
 * Sums only the proration line items (the deltas Stripe would invoice now or
 * credit), so the caller can show "you'll be charged $X" / "we'll credit $X".
 *
 * NET OF DISCOUNTS. A line's `amount` is what the price lists, before any
 * coupon or promotion code; what the customer actually owes for that line is
 * `amount` minus its `discount_amounts`. Summing the gross figure overstates
 * the quote for every discounted subscriber — and since this number is also
 * what decides the proration direction (#3157), a gross sum would call a
 * discounted increase a decrease and drop the charge. `allow_promotion_codes`
 * is set on both checkout paths, so discounted subscriptions are a state we
 * deliberately create.
 *
 * ONLY THIS PREVIEW'S PRORATIONS. `proration === true` selects every proration
 * on the upcoming invoice, not the ones this simulation created. A seat
 * decrease recorded earlier under `create_prorations` leaves a pending credit
 * sitting on that invoice, and summing it here answers the wrong question: not
 * *what does this change cost*, but *what is pending on this account*. A large
 * enough pending credit makes a real upgrade sum nonpositive, the caller reads
 * a decrease and ships `none`, and the upgrade charge is dropped — the same
 * inversion as the tier rank, the catalogue row and the undiscounted amount,
 * one level further in (#3157, PR #3171 review).
 *
 * The preview is still the money. Going to the real thing does not excuse you
 * from asking which part of it answers your question. A preview anchors every
 * proration it creates at the `proration_date` it was given, and Stripe sets
 * each such line's `period.start` to that timestamp, so the anchor is what
 * separates this change's lines from everything else on the invoice.
 *
 * Three cases, deliberately distinguished:
 *
 *  - No proration lines at all → this change prorates nothing. Zero is the
 *    true answer.
 *  - Some lines carry the anchor → sum those. They may legitimately net to
 *    zero.
 *  - Lines exist and none carry the anchor → the cost cannot be isolated.
 *    {@link ProrationAttributionError} rather than a fabricated zero: the
 *    lesson of the `?? 0` quote is that an unknown is not a nothing.
 */
/**
 * Every line of a previewed invoice, not the first handful.
 *
 * `Invoice.lines` is an `ApiList`: Stripe embeds one page and sets `has_more`
 * when there are others. That flag was in the payload and never read, so a
 * change whose credit and charge straddled the page boundary was priced from
 * whichever side happened to land first — an upgrade reading as a downgrade,
 * with no concurrency required, only enough pending invoice items.
 *
 * `listUpcomingLines` takes the same `subscription` and `subscription_details`
 * this preview was built from, so paging asks for the same invoice rather than
 * a differently-shaped one. The ordinary quote pays nothing for this: when
 * `has_more` is false the embedded page IS the whole invoice and no second call
 * is made.
 */
const MAX_PREVIEW_LINES = 1000;

async function allPreviewLines(
  stripe: Stripe,
  preview: Stripe.Invoice,
  params: Stripe.InvoiceListUpcomingLinesParams,
): Promise<Stripe.InvoiceLineItem[]> {
  if (!preview.lines?.has_more) return preview.lines?.data ?? [];
  // 100 is Stripe's per-page maximum, so the bound is ten round trips.
  const all = await stripe.invoices
    .listUpcomingLines({ ...params, limit: 100 })
    .autoPagingToArray({ limit: MAX_PREVIEW_LINES });
  if (all.length >= MAX_PREVIEW_LINES) {
    throw new ProrationLinesTruncatedError(MAX_PREVIEW_LINES);
  }
  return all;
}

/**
 * The subscription a previewed invoice was computed against, taken from the
 * preview itself.
 *
 * This exists so that nothing can supply the answer from somewhere else. The
 * caller cannot hand in a subscription it retrieved a moment ago, because it
 * is not asked for one; the only thing that can answer is the response that
 * carries the priced invoice. That is the whole difference between this and
 * what it replaces — a required parameter proved a value had been supplied,
 * never that the value described the state that was priced (r4042380655).
 *
 * `previewWithOwnedAnchor` requests `expand: ["subscription"]`, so an
 * unexpanded id or a null here means the preview did not report what it
 * priced. There is deliberately no fallback to the adapter's earlier
 * retrieval: that snapshot is from a different moment, and preferring it would
 * restore the defect in the one case this guard exists to catch. Refuse
 * instead — see {@link PreviewedSubscriptionUnavailableError}.
 */
function previewedSubscriptionOf(
  preview: Stripe.Invoice,
  subscriptionId: string,
): Stripe.Subscription {
  const sub = preview.subscription;
  if (!sub || typeof sub === "string") {
    throw new PreviewedSubscriptionUnavailableError(subscriptionId);
  }
  return sub;
}

function summarizeProration(
  preview: Stripe.Invoice,
  /** Every line of `preview`, already paged — see {@link allPreviewLines}. */
  lines: Stripe.InvoiceLineItem[],
  prorationDate: number,
  /**
   * How many prorations already sat at this anchor BEFORE the change was
   * simulated, observed from a baseline preview. Anything above zero means the
   * anchor is shared and ownership cannot be decided — see
   * {@link AmbiguousProrationAnchorError}.
   */
  pendingAtAnchor: number,
  /**
   * The subscription id being priced. Used only to name it in a refusal — the
   * subscription STATE is never passed in, because a state passed in is a
   * state observed at another moment.
   */
  subscriptionId: string,
): BillingProrationPreview {
  // Somebody else's change already occupies this second, so the lines carrying
  // our anchor are not all ours and nothing in the payload says which are.
  // Refuse rather than sum a stranger's credit into this change's direction.
  if (pendingAtAnchor > 0) {
    throw new AmbiguousProrationAnchorError(prorationDate, pendingAtAnchor);
  }
  const allProrations = lines.filter((l) => l.proration === true);
  // The anchor this preview was taken at is what makes a line ours — sound
  // only because the check above has established that no pre-existing
  // proration shares it.
  const ownProrations = allProrations.filter(
    (l) => l.period?.start === prorationDate,
  );
  if (allProrations.length > 0 && ownProrations.length === 0) {
    throw new ProrationAttributionError(prorationDate, allProrations.length);
  }
  const prorationLines = ownProrations.map((l) => {
    const discounted = (l.discount_amounts ?? []).reduce(
      (sum, d) => sum + d.amount,
      0,
    );
    return {
      description: l.description ?? "",
      amountCents: l.amount - discounted,
      proration: true,
    };
  });
  const amountCents = prorationLines.reduce((sum, l) => sum + l.amountCents, 0);
  return {
    amountCents,
    isCharge: amountCents > 0,
    currency: preview.currency,
    prorationDate,
    // Stripe's invoice `total` is already net of discounts. It is deliberately
    // NOT filtered to this preview's anchor: it is read only when the change
    // resets the billing-cycle anchor, and the invoice that reset raises really
    // does collect everything sitting on it, pending prorations included.
    //
    // It is reported, not quoted. `total` is what the invoice comes to;
    // `amount_due` is what Stripe will take, and the two part company the
    // moment the customer carries an account balance — which is why the
    // adapter has always mapped `amount_due` for issued invoices
    // (`stripeInvoiceToNeutral`) and now does the same here.
    totalCents: preview.total,
    // What is actually collected. Stripe applies the customer's credit balance
    // to `amount_due`, so this is the figure the confirmation screen means by
    // "charged now" (#3157, PR #3171 review).
    amountDueCents: preview.amount_due,
    // The interval of the subscription that was priced, off the preview's own
    // response — see `previewedSubscriptionOf`. The price and product come off
    // the SAME object, so the mutation binding and the grant origin are the
    // same single observation the direction is.
    billingInterval: pickInterval(
      previewedSubscriptionOf(preview, subscriptionId),
    ),
    billingPriceId: resolvePriceId(
      previewedSubscriptionOf(preview, subscriptionId),
    ),
    billingProductId: resolveProductId(
      previewedSubscriptionOf(preview, subscriptionId),
    ),
    lines: prorationLines,
  };
}

function stripeDisputeToNeutral(d: Stripe.Dispute): BillingDispute {
  const chargeId =
    typeof d.charge === "string" ? d.charge : (d.charge?.id ?? null);
  const piRef = d.payment_intent;
  const paymentIntentId = piRef
    ? typeof piRef === "string"
      ? piRef
      : piRef.id
    : null;
  return {
    id: d.id,
    chargeId,
    paymentIntentId,
    amountCents: d.amount,
    currency: d.currency,
    reason: d.reason ?? null,
    status: d.status,
    orgId: (d.metadata?.org_id as string | undefined) ?? null,
  };
}

function stripeChargeToNeutral(c: Stripe.Charge): BillingRefundedCharge {
  const piRef = c.payment_intent;
  const paymentIntentId = piRef
    ? typeof piRef === "string"
      ? piRef
      : piRef.id
    : null;
  return {
    id: c.id,
    paymentIntentId,
    amountRefundedCents: c.amount_refunded,
    currency: c.currency,
    orgId: (c.metadata?.org_id as string | undefined) ?? null,
    metadata: (c.metadata as Record<string, string>) ?? {},
  };
}

/**
 * What a failed Stripe read establishes.
 *
 * "definitive" — Stripe looked and answered about the resource, and the answer
 * cannot change on its own. The identical call returns the identical thing on
 * the redelivery, so the caller's "no metadata" branch is the correct one.
 *
 * "retry" — the call established nothing about the resource. Either it never
 * reached Stripe, or it failed on a condition someone can CORRECT, after which
 * the unchanged call returns real data.
 *
 * The test is not "did Stripe answer" but "can this answer change on its own?"
 * — which is why a permission error is not definitive: an operator grants the
 * key `charges:read` and the same request then succeeds. That is a fact about
 * our configuration, not about the charge.
 *
 * The two costs are not symmetric and the asymmetry is what decides every
 * doubtful case. Wrongly retrying costs a redelivery. Wrongly finalising costs
 * the units: no metadata means no organisation, so the dispute is not parked,
 * the handler RETURNS, `processStripeEvent` marks the event processed for ever,
 * and the retried checkout grants every disputed unit. Unknown therefore
 * resolves to "retry", never to "definitive".
 */
type StripeReadDisposition = "definitive" | "retry";

/**
 * The error types this build's Stripe SDK DECLARES it can tag a thrown error
 * with. An upgrade that adds a declared type widens this union, and the
 * `satisfies` below then fails to compile until the new type is classified.
 *
 * It is narrower than what the SDK can actually throw, and the gap is the case
 * the check exists for. In stripe@17.7.0 `generateV1Error`'s DEFAULT branch
 * constructs `StripeUnknownError` (`cjs/Error.js`), and that name appears
 * nowhere in `types/Errors.d.ts` — so the compiler cannot see the SDK's own
 * fallback class. Whatever this union is missing reaches `stripeReadDisposition`
 * as a string with no entry, which is why the runtime fallback below is doing
 * real work rather than belt-and-braces: it, not the compiler, is what keeps an
 * unrecognised error on the retry side.
 */
type StripeErrorType = Stripe.errors.StripeError["type"];

/**
 * The fork as a TOTAL mapping rather than a pair of lists.
 *
 * A list-shaped classifier is cheap to extend and silent when extended wrongly:
 * an error absent from both lists, or added to the wrong one, fails in the
 * direction of granting units and nothing says so. A total map over the SDK's
 * own union makes the next error type a COMPILE error instead of a default —
 * whoever upgrades the SDK has to answer the question rather than inherit an
 * answer. `stripeReadDisposition` keeps a runtime fallback as well, because the
 * value arrives as `unknown` and a string this build has never heard of is
 * exactly the case a compiler cannot see.
 */
const STRIPE_READ_DISPOSITION = {
  // The one fact here that cannot change on its own. Narrowed further by code
  // below: only `resource_missing` is "Stripe looked and there is no such
  // charge". Every other invalid request is a bug or a misconfiguration on our
  // side — a bad expand, a wrong API version — which someone corrects and
  // redeploys, so it belongs with the correctable ones.
  StripeInvalidRequestError: "definitive",

  // Correctable by an operator, without any change to this call.
  StripePermissionError: "retry",
  StripeAuthenticationError: "retry",
  StripeInvalidGrantError: "retry",
  TemporarySessionExpiredError: "retry",

  // Never reached Stripe, or Stripe could not answer.
  StripeConnectionError: "retry",
  StripeAPIError: "retry",
  StripeRateLimitError: "retry",

  // Cannot arise from a charge read. Mapped anyway so the table stays total,
  // and mapped to the safe side so that if one ever does, it costs a
  // redelivery rather than the units.
  StripeError: "retry",
  StripeCardError: "retry",
  StripeIdempotencyError: "retry",
  StripeSignatureVerificationError: "retry",
} satisfies Record<StripeErrorType, StripeReadDisposition>;

/** Stripe's code for "I looked, and there is no such object." */
const STRIPE_RESOURCE_MISSING = "resource_missing";

function stripeReadDisposition(err: unknown): StripeReadDisposition {
  const fields = err as { type?: unknown; code?: unknown } | null;
  const type = fields?.type;
  if (typeof type !== "string") return "retry";

  // Deliberately indexed as a plain record rather than asserted to
  // `StripeErrorType`: at runtime the string can be a type this build's SDK
  // does not have, and that is the case the compiler cannot reach.
  const disposition = (
    STRIPE_READ_DISPOSITION as Record<string, StripeReadDisposition | undefined>
  )[type];
  if (disposition !== "definitive") return "retry";

  // "Definitive" means the object is gone, not merely that the request was
  // rejected. An invalid request for any other reason is our defect, and our
  // defects get corrected.
  return fields?.code === STRIPE_RESOURCE_MISSING ? "definitive" : "retry";
}

/** Micro-dollars in one cent. */
const MICROS_PER_CENT = 10_000n;

/**
 * A per-GAU rate in micros as Stripe's `unit_amount_decimal`, which is in
 * cents: exact, at most four decimal places (6000 → "0.6", 12345 → "1.2345").
 * Stripe rounds the line once; the app computes no invoice amount.
 */
function microsToCentsDecimal(micros: bigint): string {
  const whole = micros / MICROS_PER_CENT;
  const fraction = (micros % MICROS_PER_CENT)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** The fields of a Stripe API error the settlement path classifies on. */
function stripeErrorFields(err: unknown): {
  rawType?: string;
  code?: string;
  message?: string;
} {
  return typeof err === "object" && err !== null ? err : {};
}

/**
 * Whether a failed `invoices.pay` leaves a finalized, unpaid invoice that
 * Stripe goes on collecting: a declined card, a payment that needs the
 * customer (SCA), or a customer with nothing to charge. Stripe gives the last
 * no error code, so it is matched on its message.
 */
function isUncollectedPayment(err: unknown): boolean {
  const { rawType, code, message } = stripeErrorFields(err);
  if (rawType === "card_error") return true;
  if (code === "invoice_payment_intent_requires_action") return true;
  return (
    rawType === "invalid_request_error" &&
    /no attached payment source/i.test(message ?? "")
  );
}

function isResourceMissing(err: unknown): boolean {
  return stripeErrorFields(err).code === "resource_missing";
}

// ── Stripe client singleton ──────────────────────────────────────────────────

let _stripe: Stripe | null = null;

/**
 * Raw Stripe client singleton. Exported for the `billing:stripe-sync` tooling
 * script, which legitimately needs direct Stripe Product/Price API access to
 * provision the catalog. Application/domain code must NOT use this — go through
 * the `BillingProvider` port (`billingProvider()`) to preserve vendor neutrality.
 */
export function stripeClient(): Stripe {
  if (_stripe) return _stripe;
  const env = requireEnv(["STRIPE_SECRET_KEY"] as const);
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
    typescript: true,
    appInfo: { name: "oxagen", version: "0.1.0" },
  });
  return _stripe;
}

// ── Translation helpers ──────────────────────────────────────────────────────

const ALLOWED_SUB_STATUSES = new Set<Stripe.Subscription.Status>([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

function toSubscriptionStatus(raw: string): BillingSubscriptionStatus {
  return ALLOWED_SUB_STATUSES.has(raw as Stripe.Subscription.Status)
    ? (raw as BillingSubscriptionStatus)
    : "incomplete";
}

function pickInterval(sub: Stripe.Subscription): "month" | "year" {
  const interval = sub.items.data[0]?.price?.recurring?.interval;
  return interval === "year" ? "year" : "month";
}

function resolveProductId(sub: Stripe.Subscription): string | null {
  const product = sub.items.data[0]?.price?.product;
  if (!product) return null;
  return typeof product === "string" ? product : product.id;
}

function resolvePriceId(sub: Stripe.Subscription): string | null {
  return sub.items.data[0]?.price?.id ?? null;
}

function resolveCustomerId(
  ref: string | Stripe.Customer | Stripe.DeletedCustomer,
): string {
  return typeof ref === "string" ? ref : ref.id;
}

function resolveSubscriptionRef(
  ref: string | Stripe.Subscription | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** A Stripe reference that is an id or an expanded object, to its id. */
function resolveRef(
  ref: string | { id: string } | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function checkoutSessionToNeutral(
  sess: Stripe.Checkout.Session,
): BillingCheckoutSession {
  return {
    id: sess.id,
    mode: sess.mode ?? "",
    paymentStatus: sess.payment_status ?? "",
    customerId: resolveRef(sess.customer),
    metadata: (sess.metadata as Record<string, string>) ?? {},
    subscriptionId: resolveSubscriptionRef(sess.subscription),
    invoiceId: resolveRef(sess.invoice),
    paymentIntentId: resolveRef(sess.payment_intent),
    amountTotalCents: sess.amount_total ?? null,
  };
}

/**
 * Stripe's Basil-era API (2025-03-31+) REMOVED the top-level `Invoice.subscription`
 * field; an invoice's subscription reference and the subscription's metadata now
 * live under `invoice.parent.subscription_details`. A Stripe account renders
 * webhook payloads (and REST responses) at its OWN default API version regardless
 * of the SDK's pinned `apiVersion`, so once the account is on Basil+, invoices
 * arrive in the new shape even though the pinned stripe-node types (acacia) still
 * expose the legacy `subscription` field.
 *
 * Reading only `invoice.subscription` therefore yields null in production: that
 * nulls `BillingInvoice.subscriptionId`, which makes `grantPlanCreditsForInvoicePaid`
 * return at its `!invoice.subscriptionId` guard and `syncInvoiceFromStripe` fail to
 * resolve a tenant — so a free→paid upgrade's included credits are silently never
 * granted. Resolve the subscription id and the org id from BOTH shapes.
 */
interface InvoiceSubscriptionParent {
  subscription_details?: {
    subscription?: string | { id: string } | null;
    metadata?: Record<string, string> | null;
  } | null;
}

function invoiceParent(
  invoice: Stripe.Invoice,
): InvoiceSubscriptionParent | null {
  return (
    (invoice as unknown as { parent?: InvoiceSubscriptionParent | null })
      .parent ?? null
  );
}

function resolveInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Legacy top-level field (≤ acacia) first…
  const top = resolveSubscriptionRef(invoice.subscription);
  if (top) return top;
  // …then the Basil-era parent.subscription_details.subscription (string | {id}).
  const parentSub =
    invoiceParent(invoice)?.subscription_details?.subscription ?? null;
  if (!parentSub) return null;
  return typeof parentSub === "string" ? parentSub : parentSub.id;
}

function resolveInvoiceOrgId(invoice: Stripe.Invoice): string | null {
  const direct = (invoice.metadata?.org_id as string | undefined) ?? null;
  if (direct) return direct;
  // Subscription invoices stamp org_id on subscription_data.metadata, which now
  // surfaces here as parent.subscription_details.metadata — resolving it lets the
  // invoice bind to its tenant even before the subscription row is synced.
  return invoiceParent(invoice)?.subscription_details?.metadata?.org_id ?? null;
}

function stripeInvoiceToNeutral(invoice: Stripe.Invoice): BillingInvoice {
  const ALLOWED_INV_STATUSES = new Set([
    "draft",
    "open",
    "paid",
    "void",
    "uncollectible",
  ]);
  const status = ALLOWED_INV_STATUSES.has(invoice.status ?? "")
    ? (invoice.status as string)
    : "draft";

  const lineItems: BillingInvoiceLineItem[] = (invoice.lines?.data ?? []).map(
    (line) => ({
      description: line.description ?? "",
      quantity: line.quantity ?? 1,
      unitAmountCents: line.price?.unit_amount ?? 0,
      totalCents: line.amount,
      metric: (line.metadata?.metric as string | undefined) ?? null,
      metadata: (line.metadata as Record<string, string>) ?? {},
    }),
  );

  const orgId = resolveInvoiceOrgId(invoice);
  const subId = resolveInvoiceSubscriptionId(invoice);

  return {
    id: invoice.id,
    providerInvoiceId: invoice.id,
    number: invoice.number ?? null,
    status: status as BillingInvoice["status"],
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    amountRemainingCents: invoice.amount_remaining,
    currency: invoice.currency,
    periodStart: new Date(invoice.period_start * 1000),
    periodEnd: new Date(invoice.period_end * 1000),
    dueAt: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    paidAt: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    subscriptionId: subId,
    orgId,
    billingReason: invoice.billing_reason ?? null,
    gauSettlementId:
      (invoice.metadata?.gau_settlement_id as string | undefined) ?? null,
    prepaidOrder: prepaidOrderOf(invoice.metadata),
    lineItems,
  };
}

/**
 * The prepaid order an invoice bills, from the metadata createPrepaidInvoice
 * wrote: `oxagen_kind: "prepaid_order"`, `prepaid_order_id`, and optionally
 * `assistant_spend_cap_cents` (`none` or digits). Null for any other invoice.
 * A prepaid invoice whose cap value is neither is read as `unchanged` and
 * logged: a grant that guessed a cap would set a figure nobody chose.
 */
function prepaidOrderOf(
  metadata: Stripe.Metadata | null | undefined,
): BillingPrepaidOrderRef | null {
  if (metadata?.oxagen_kind !== "prepaid_order") return null;
  const orderId = metadata.prepaid_order_id;
  if (!orderId) return null;
  const cap = metadata.assistant_spend_cap_cents;
  if (cap === undefined || cap === "") {
    return { orderId, assistantSpendCap: { kind: "unchanged" } };
  }
  if (cap === "none") {
    return { orderId, assistantSpendCap: { kind: "set", capCents: null } };
  }
  if (/^\d+$/.test(cap) && Number.isSafeInteger(Number(cap))) {
    return {
      orderId,
      assistantSpendCap: { kind: "set", capCents: Number(cap) },
    };
  }
  logger.error(
    { orderId, assistantSpendCapCents: cap },
    "billing: prepaid invoice carries an unreadable assistant cap; leaving the cap unchanged",
  );
  return { orderId, assistantSpendCap: { kind: "unchanged" } };
}

/**
 * How many prorations already sit at `prorationDate` on this subscription's
 * upcoming invoice, BEFORE any change is simulated.
 *
 * This is the whole ownership test. `proration_date` is Unix seconds, so a
 * change committed in the same second as a preview stamps its proration with
 * our anchor and is indistinguishable from ours by timestamp. Rather than
 * guess at a payload field that might mean ownership, ask what was already
 * there: a preview with no `subscription_details` is the invoice as it stands.
 *
 * Read-only, and it issues nothing — the same call the change preview makes,
 * without the change. It costs one round trip per quote, which is the trade
 * this PR has taken every time the cheap answer turned out to be the wrong one.
 */
async function prorationsAlreadyAtAnchor(
  stripe: Stripe,
  subscriptionId: string,
  prorationDate: number,
): Promise<number> {
  const baseline = await stripe.invoices.createPreview({
    subscription: subscriptionId,
  });
  // Paged for the same reason the change preview is: an interloper sitting
  // beyond the embedded page would leave this at zero, and the ownership check
  // would pass by not looking.
  const lines = await allPreviewLines(stripe, baseline, {
    subscription: subscriptionId,
  });
  return lines.filter(
    (l) => l.proration === true && l.period?.start === prorationDate,
  ).length;
}

/**
 * The changed preview, bracketed by a baseline read on either side of it.
 *
 * One baseline is a time-of-check/time-of-use pair: a change committed AFTER
 * the baseline returns and BEFORE the changed preview runs stamps its proration
 * with our second, is absent from the baseline, and is summed as ours.
 *
 * WHY THIS AND NOT A LOCK. Corruption requires the interloper to be present in
 * the changed preview, which means it was committed before that call returned —
 * so a baseline taken AFTER it sees everything that could have corrupted it.
 * Serializing our own mutations would not do as well: a Stripe subscription is
 * also mutated from the Dashboard, the customer portal and any other
 * integration on the account, none of which will ever take a lock held in this
 * process, and the lock would be held across provider I/O to buy it.
 *
 * WHAT IS LEFT. This narrows the window; it does not provably close it. A
 * proration present in the changed preview but swept onto a finalised invoice
 * before the closing read would be invisible to both baselines. That is why
 * BOTH reads are consulted rather than only the closing one — the opening read
 * is the only thing that sees that case — and why the residual is stated here
 * rather than described as fixed. It is bounded by one HTTP round trip and
 * requires an invoice to finalise inside it (#3157, PR #3171 review).
 *
 * Either observation finding a proration at our anchor is contention in this
 * second, and both refuse. A refusal costs a retry with a fresh anchor; a
 * stranger's credit summed into an upgrade is a charge never raised.
 */
async function previewWithOwnedAnchor(
  stripe: Stripe,
  subscriptionId: string,
  prorationDate: number,
  subscriptionDetails: Stripe.InvoiceCreatePreviewParams.SubscriptionDetails,
): Promise<{
  preview: Stripe.Invoice;
  lines: Stripe.InvoiceLineItem[];
  pendingAtAnchor: number;
}> {
  const before = await prorationsAlreadyAtAnchor(
    stripe,
    subscriptionId,
    prorationDate,
  );
  // `expand` is what makes this ONE observation rather than two.
  //
  // The interval that decides whether this change resets the billing-cycle
  // anchor has to come from the subscription the invoice was PRICED against.
  // The adapter retrieves the subscription just before this, to find the item
  // to reprice, and using that retrieval for the interval as well was the
  // defect: two requests, a window between them, and a plan update landing in
  // it makes the earlier snapshot a label rather than a derivation
  // (r4042380655).
  //
  // PROVED, and true by construction: expanding it here returns the
  // subscription on the SAME request that computes the invoice. There is no
  // window to straddle and no second value to keep in step, because there is
  // no second request.
  //
  // ASSUMED, and NOT verified against a live account: that the expanded
  // `subscription` is the STORED resource as this request saw it, rather than
  // an object reflecting the `subscription_details` overrides the preview was
  // asked to simulate. `subscription_details` governs what the preview
  // COMPUTES, and `invoice.subscription` reads as a reference to the
  // subscription resource, so the stored reading is the one this code is
  // written to — but no Stripe script has been run against any account on this
  // change, sandbox included, and a test double cannot falsify the assumption
  // it was written from. Settling it needs a live account, which is a
  // maintainer action.
  //
  // IF THAT ASSUMPTION IS FALSE, it fails into the original bug rather than
  // into an error: `billingInterval` would be the interval being moved TO, the
  // caller would compare the target against itself, score every change
  // same-interval, select `none` and quote $0 for an anchor reset that
  // invoices a full period. That is why it is not left to a comment.
  // `previewPlanChange` below asks the single response to be self-consistent
  // and refuses when it is not — see {@link SimulatedPreviewSubscriptionError}
  // for why the price alone cannot be the test.
  const preview = await stripe.invoices.createPreview({
    subscription: subscriptionId,
    subscription_details: subscriptionDetails,
    expand: ["subscription"],
  });
  const lines = await allPreviewLines(stripe, preview, {
    subscription: subscriptionId,
    subscription_details:
      subscriptionDetails as Stripe.InvoiceListUpcomingLinesParams.SubscriptionDetails,
  });
  const after = await prorationsAlreadyAtAnchor(
    stripe,
    subscriptionId,
    prorationDate,
  );
  return { preview, lines, pendingAtAnchor: Math.max(before, after) };
}

function stripeSubscriptionToNeutral(
  sub: Stripe.Subscription,
): BillingSubscription {
  return {
    id: sub.id,
    customerId: resolveCustomerId(sub.customer),
    metadata: (sub.metadata as Record<string, string>) ?? {},
    status: toSubscriptionStatus(sub.status),
    billingInterval: pickInterval(sub),
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    productId: resolveProductId(sub),
    priceId: resolvePriceId(sub),
    seatCount: sub.items.data[0]?.quantity ?? 1,
  };
}

function stripePaymentMethodToNeutral(
  pm: Stripe.PaymentMethod,
): BillingPaymentMethod {
  const customerRef = pm.customer;
  const customerId = customerRef
    ? typeof customerRef === "string"
      ? customerRef
      : customerRef.id
    : "";
  return {
    id: pm.id,
    customerId,
    type: pm.type,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    expMonth: pm.card?.exp_month ?? null,
    expYear: pm.card?.exp_year ?? null,
  };
}

function stripeEventType(stripeType: string): BillingWebhookEventType {
  switch (stripeType) {
    case "customer.subscription.created":
      return "subscription.created";
    case "customer.subscription.updated":
      return "subscription.updated";
    case "customer.subscription.deleted":
      return "subscription.deleted";
    case "customer.subscription.trial_will_end":
      return "subscription.trial_will_end";
    case "invoice.created":
      return "invoice.created";
    case "invoice.paid":
      return "invoice.paid";
    case "invoice.payment_failed":
      return "invoice.payment_failed";
    case "invoice.payment_action_required":
      return "invoice.payment_action_required";
    case "invoice.finalized":
      return "invoice.finalized";
    case "invoice.voided":
      return "invoice.voided";
    case "invoice.marked_uncollectible":
      return "invoice.marked_uncollectible";
    case "checkout.session.completed":
      return "checkout.session.completed";
    case "payment_method.attached":
      return "payment_method.attached";
    case "payment_method.detached":
      return "payment_method.detached";
    case "payment_method.updated":
    case "payment_method.automatically_updated":
      return "payment_method.updated";
    case "charge.dispute.created":
      return "dispute.created";
    case "charge.dispute.closed":
      return "dispute.closed";
    case "charge.refunded":
      return "charge.refunded";
    default:
      return "unknown";
  }
}

// ── StripeProvider ───────────────────────────────────────────────────────────

export class StripeProvider implements BillingProvider {
  /** The Stripe client every method operates against: the platform env singleton. */
  private client(): Stripe {
    return stripeClient();
  }

  // ── Customer ────────────────────────────────────────────────────────────────

  async findCustomerByOrgId(
    orgId: string,
  ): Promise<BillingCustomerSearchResult | null> {
    const stripe = this.client();
    const found = await stripe.customers.search({
      query: `metadata['org_id']:'${orgId}'`,
      limit: 1,
    });
    return found.data[0] ? { id: found.data[0].id } : null;
  }

  async customerExists(customerId: string): Promise<boolean> {
    try {
      const cust = await this.client().customers.retrieve(customerId);
      return !cust.deleted;
    } catch (err) {
      if (isResourceMissing(err)) return false;
      throw err;
    }
  }

  async createCustomer(input: BillingCustomerCreateInput): Promise<string> {
    const stripe = this.client();
    const customer = await stripe.customers.create({
      name: input.name,
      metadata: input.metadata,
    });
    return customer.id;
  }

  // ── Subscription ────────────────────────────────────────────────────────────

  async getSubscription(subscriptionId: string): Promise<BillingSubscription> {
    const sub = await this.client().subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price.product"],
    });
    return stripeSubscriptionToNeutral(sub);
  }

  async updateSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpdateInput,
  ): Promise<void> {
    const params: Stripe.SubscriptionUpdateParams = {};
    if (input.cancelAtPeriodEnd !== undefined) {
      params.cancel_at_period_end = input.cancelAtPeriodEnd;
    }
    await this.client().subscriptions.update(subscriptionId, params);
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.client().subscriptions.cancel(subscriptionId);
  }

  async upgradeSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpgradeInput,
  ): Promise<void> {
    const stripe = this.client();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");

    // The proration decision was made against a specific price. Stripe has no
    // conditional update, so this retrieval — which the swap takes anyway, one
    // round trip from the write — is asked whether that price still holds.
    //
    // Refusing, not adapting: a change that is no longer the change that was
    // priced needs a fresh preview, and carrying `none` onto a different
    // transition is how a real charge goes unraised. See
    // {@link SubscriptionMovedError} for the evidence that no CAS primitive
    // exists and for the residual this leaves.
    const actualPriceId = resolvePriceId(sub);
    if (
      input.expectedCurrentPriceId !== undefined &&
      actualPriceId !== input.expectedCurrentPriceId
    ) {
      throw new SubscriptionMovedError(
        subscriptionId,
        input.expectedCurrentPriceId,
        actualPriceId,
      );
    }
    const prorationBehavior = input.prorationBehavior ?? "always_invoice";
    // The anchor the preview priced at, when there was one.
    //
    // Left off, Stripe anchors the proration at the moment it processes THIS
    // request, which is not the moment the preview was computed at — and the
    // unused credit for the old price decays between the two. For a
    // same-interval upgrade that shrinks the charge, which a ceiling accepts;
    // for an interval change the charge is the new period less that decaying
    // credit, so it GROWS, and the approved maximum checked one call earlier
    // can be passed and exceeded anyway.
    //
    // Sending it also makes the anchor a parameter of the request rather than
    // a function of when it is served, so an idempotent retry that reaches
    // Stripe fresh reproduces the same invoice instead of re-anchoring.
    //
    // A `proration_date` outside the subscription's current period is refused
    // by Stripe. That is the correct outcome and not a new failure mode: a
    // preview whose period has since rolled over priced a change that no
    // longer exists, and it must be taken again.
    const params: Stripe.SubscriptionUpdateParams = {
      items: [{ id: item.id, price: input.newPriceId }],
      proration_behavior: prorationBehavior,
    };
    if (input.prorationDate !== undefined) {
      params.proration_date = input.prorationDate;
    }
    await stripe.subscriptions.update(
      subscriptionId,
      params,
      idempotency(input.idempotencyKey),
    );
  }

  async setSubscriptionSeats(
    subscriptionId: string,
    input: BillingSubscriptionSeatUpdateInput,
  ): Promise<void> {
    const stripe = this.client();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    // Increases default to immediate invoice (charge now); decreases pass
    // 'create_prorations' so the credit rolls to the next invoice — never an
    // immediate negative charge. The domain layer decides which.
    await stripe.subscriptions.update(
      subscriptionId,
      {
        items: [{ id: item.id, quantity: input.seats }],
        proration_behavior: input.prorationBehavior ?? "always_invoice",
      },
      idempotency(input.idempotencyKey),
    );
  }

  async previewSeatChange(
    subscriptionId: string,
    input: BillingSeatPreviewInput,
  ): Promise<BillingProrationPreview> {
    const stripe = this.client();
    // Retrieved for ONE thing: which subscription item to reprice. The state
    // it reports decides nothing, and in particular does not supply the
    // interval — that comes off the preview response, because this retrieval
    // and the preview are separate requests (r4042380655).
    //
    // This use does not straddle that window in the same way. A stale item id
    // cannot make a same-interval change look like an interval change, or the
    // reverse: if the item has been removed or replaced, `createPreview` fails
    // with a provider error and nothing is priced, rather than pricing the
    // wrong thing quietly.
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    const prorationDate = Math.floor(Date.now() / 1000);
    const { preview, lines, pendingAtAnchor } = await previewWithOwnedAnchor(
      stripe,
      subscriptionId,
      prorationDate,
      {
        items: [{ id: item.id, quantity: input.seats }],
        proration_behavior: input.prorationBehavior ?? "always_invoice",
        proration_date: prorationDate,
      },
    );
    return summarizeProration(
      preview,
      lines,
      prorationDate,
      pendingAtAnchor,
      subscriptionId,
    );
  }

  async previewPlanChange(
    subscriptionId: string,
    input: BillingPlanPreviewInput,
  ): Promise<BillingProrationPreview> {
    const stripe = this.client();
    // Retrieved for ONE thing: which subscription item to reprice. The state
    // it reports decides nothing, and in particular does not supply the
    // interval — that comes off the preview response, because this retrieval
    // and the preview are separate requests (r4042380655).
    //
    // This use does not straddle that window in the same way. A stale item id
    // cannot make a same-interval change look like an interval change, or the
    // reverse: if the item has been removed or replaced, `createPreview` fails
    // with a provider error and nothing is priced, rather than pricing the
    // wrong thing quietly.
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    const prorationDate = Math.floor(Date.now() / 1000);
    const { preview, lines, pendingAtAnchor } = await previewWithOwnedAnchor(
      stripe,
      subscriptionId,
      prorationDate,
      {
        items: [{ id: item.id, price: input.newPriceId }],
        proration_behavior: input.prorationBehavior ?? "always_invoice",
        proration_date: prorationDate,
      },
    );
    const summary = summarizeProration(
      preview,
      lines,
      prorationDate,
      pendingAtAnchor,
      subscriptionId,
    );

    // The single source, asked to be self-consistent.
    //
    // Everything above rests on the expanded `subscription` being the stored
    // resource rather than a simulation of the change (see the `expand` site).
    // That property cannot be tested from here, and if it were false this
    // would quote $0 for an anchor reset and look right doing it. So the one
    // response is checked against itself: a subscription genuinely on the
    // target price cannot also be charged for moving to it.
    //
    // `input.newPriceId` is a request parameter, not a reading of anything, so
    // this is a check on ONE observation and not a comparison of two — it is
    // not the guard shape that keeps failing.
    //
    // The price alone cannot be the test: the quote path has no
    // already-applied guard, so previewing the plan you are ALREADY on is a
    // legitimate question whose answer is zero. It is the conjunction — on the
    // target price AND real money moving for the move — that is impossible of
    // a stored subscription.
    const priced = previewedSubscriptionOf(preview, subscriptionId);
    if (
      resolvePriceId(priced) === input.newPriceId &&
      summary.amountCents !== 0
    ) {
      throw new SimulatedPreviewSubscriptionError(
        subscriptionId,
        input.newPriceId,
        summary.amountCents,
      );
    }
    return summary;
  }

  // ── Payment methods ───────────────────────────────────────────────────────────

  async listPaymentMethods(
    customerId: string,
  ): Promise<BillingPaymentMethod[]> {
    const res = await this.client().paymentMethods.list({
      customer: customerId,
      type: "card",
    });
    return res.data.map(stripePaymentMethodToNeutral);
  }

  async getDefaultPaymentMethodId(customerId: string): Promise<string | null> {
    const cust = await this.client().customers.retrieve(customerId);
    if (cust.deleted) return null;
    const dpm = (cust as Stripe.Customer).invoice_settings
      ?.default_payment_method;
    if (!dpm) return null;
    return typeof dpm === "string" ? dpm : dpm.id;
  }

  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void> {
    await this.client().customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.client().paymentMethods.detach(paymentMethodId);
  }

  async createSetupIntent(customerId: string): Promise<BillingSetupIntent> {
    const si = await this.client().setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });
    if (!si.client_secret)
      throw new Error("Stripe did not return a SetupIntent client secret");
    return { clientSecret: si.client_secret, setupIntentId: si.id };
  }

  async chargeOffSession(
    input: BillingOffSessionChargeInput,
  ): Promise<BillingOffSessionChargeResult> {
    const stripe = this.client();
    // Resolve a card to charge: explicit > customer default. PaymentIntent
    // confirmation requires a concrete payment_method off-session.
    const paymentMethodId =
      input.paymentMethodId ??
      (await this.getDefaultPaymentMethodId(input.customerId));
    if (!paymentMethodId) {
      throw new Error("no payment method on file for off-session charge");
    }
    const pi = await stripe.paymentIntents.create(
      {
        customer: input.customerId,
        amount: input.amountCents,
        currency: "usd",
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: input.description,
        metadata: input.metadata,
      },
      idempotency(input.idempotencyKey),
    );
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      succeeded: pi.status === "succeeded",
    };
  }

  // ── Invoice ─────────────────────────────────────────────────────────────────

  async getInvoice(invoiceId: string): Promise<BillingInvoice> {
    const invoice = await this.client().invoices.retrieve(invoiceId, {
      expand: ["lines.data.price"],
    });
    return stripeInvoiceToNeutral(invoice);
  }

  async createGauInvoice(
    input: BillingGauInvoiceInput,
  ): Promise<{ invoiceId: string }> {
    const stripe = this.client();
    const collection: Pick<
      Stripe.InvoiceCreateParams,
      "collection_method" | "default_payment_method" | "days_until_due"
    > =
      input.collection.method === "charge_automatically"
        ? {
            collection_method: "charge_automatically",
            default_payment_method: input.collection.defaultPaymentMethodId,
          }
        : {
            collection_method: "send_invoice",
            days_until_due: input.collection.daysUntilDue,
          };
    // auto_advance false: the draft stays a draft until
    // finalizeAndPayGauInvoice finalizes it, so a draft Oxagen abandons is
    // never collected (https://docs.stripe.com/invoicing/integration/automatic-advancement-collection).
    const invoice = await stripe.invoices.create(
      {
        customer: input.customerId,
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        metadata: {
          org_id: input.orgId,
          oxagen_kind: input.kind,
          gau_settlement_id: input.settlementId,
          gau_quantity: String(input.quantityGau),
          rate_per_gau_micros: input.ratePerGauMicros.toString(),
          currency: input.currency,
        },
        ...collection,
      },
      { idempotencyKey: `${input.settlementId}:invoice` },
    );
    await stripe.invoiceItems.create(
      {
        customer: input.customerId,
        invoice: invoice.id,
        quantity: input.quantityGau,
        unit_amount_decimal: microsToCentsDecimal(input.ratePerGauMicros),
        currency: input.currency,
        description: input.description,
        period: providerPeriodSeconds(input.period),
      },
      { idempotencyKey: `${input.settlementId}:item` },
    );
    return { invoiceId: invoice.id };
  }

  async createPrepaidInvoice(
    input: BillingPrepaidInvoiceInput,
  ): Promise<{ invoiceId: string }> {
    const stripe = this.client();
    // auto_advance false: the draft is sent only by sendPrepaidInvoice, after
    // its subtotal is checked against the order. send_invoice: an enterprise
    // pays by bank transfer or on the hosted page, never from a saved card.
    const invoice = await stripe.invoices.create(
      {
        customer: input.customerId,
        auto_advance: false,
        collection_method: "send_invoice",
        days_until_due: input.daysUntilDue,
        currency: input.currency,
        pending_invoice_items_behavior: "exclude",
        ...(input.customFields.length > 0
          ? { custom_fields: input.customFields }
          : {}),
        ...(input.memo ? { description: input.memo } : {}),
        footer: input.footer,
        metadata: {
          ...input.metadata,
          org_id: input.orgId,
          oxagen_kind: "prepaid_order",
          prepaid_order_id: input.orderId,
        },
      },
      { idempotencyKey: `${input.orderId}:invoice` },
    );
    for (const line of input.lines) {
      await stripe.invoiceItems.create(
        {
          customer: input.customerId,
          invoice: invoice.id,
          quantity: line.quantity,
          unit_amount_decimal: line.unitAmountDecimal,
          currency: input.currency,
          description: line.description,
          ...(line.period
            ? { period: providerPeriodSeconds(line.period) }
            : {}),
          metadata: { prepaid_order_id: input.orderId, line: line.key },
        },
        { idempotencyKey: `${input.orderId}:item:${line.key}` },
      );
    }
    return { invoiceId: invoice.id };
  }

  async sendPrepaidInvoice(
    ref: BillingPrepaidInvoiceRef,
  ): Promise<BillingPrepaidInvoiceState> {
    const stripe = this.client();
    let invoice = await stripe.invoices.retrieve(ref.invoiceId);
    if (invoice.status === "draft") {
      if (invoice.subtotal !== ref.expectedSubtotalCents) {
        throw new Error(
          `billing: prepaid invoice ${ref.invoiceId} subtotals ${invoice.subtotal}, the order ${ref.expectedSubtotalCents}; not sent`,
        );
      }
      // Sending a draft finalizes it and emails it in one request
      // (https://docs.stripe.com/api/invoices/send). Keyed on the order, so a
      // retry inside the idempotency window sends one email.
      invoice = await stripe.invoices.sendInvoice(
        ref.invoiceId,
        {},
        { idempotencyKey: `${ref.orderId}:send` },
      );
    }
    if (invoice.status !== "open" && invoice.status !== "paid") {
      throw new Error(
        `billing: prepaid invoice ${ref.invoiceId} is ${invoice.status}, neither open nor paid`,
      );
    }
    return {
      status: invoice.status,
      number: invoice.number ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdfUrl: invoice.invoice_pdf ?? null,
      amountDueCents: invoice.amount_due,
      assistantSpendCap: prepaidOrderOf(invoice.metadata)
        ?.assistantSpendCap ?? {
        kind: "unchanged",
      },
    };
  }

  async finalizeAndPayGauInvoice(
    ref: BillingGauInvoiceRef,
  ): Promise<BillingGauInvoicePayment> {
    const stripe = this.client();
    let invoice = await stripe.invoices.retrieve(ref.invoiceId);
    if (invoice.status === "draft") {
      // auto_advance true from here: Stripe's collection and retry schedule
      // apply to the invoice Oxagen finalized.
      invoice = await stripe.invoices.finalizeInvoice(
        ref.invoiceId,
        { auto_advance: true },
        { idempotencyKey: `${ref.settlementId}:finalize` },
      );
    }
    if (
      invoice.status === "open" &&
      invoice.collection_method === "charge_automatically"
    ) {
      try {
        invoice = await stripe.invoices.pay(
          ref.invoiceId,
          { off_session: true },
          { idempotencyKey: `${ref.settlementId}:pay` },
        );
      } catch (err) {
        if (!isUncollectedPayment(err)) throw err;
      }
    }
    if (invoice.status !== "paid" && invoice.status !== "open") {
      throw new Error(
        `billing: settlement invoice ${ref.invoiceId} is ${invoice.status}, neither paid nor open`,
      );
    }
    return {
      status: invoice.status,
      amountCents: invoice.amount_due,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    };
  }

  async deleteOrVoidDraftInvoice(
    ref: BillingGauInvoiceRef,
  ): Promise<{ outcome: BillingDraftInvoiceOutcome }> {
    const stripe = this.client();
    let invoice: Stripe.Invoice;
    try {
      invoice = await stripe.invoices.retrieve(ref.invoiceId);
    } catch (err) {
      if (isResourceMissing(err)) return { outcome: "absent" };
      throw err;
    }
    if (invoice.status === "void") return { outcome: "absent" };
    if (invoice.status === "paid") return { outcome: "paid" };
    if (invoice.status === "draft") {
      try {
        await stripe.invoices.del(ref.invoiceId);
      } catch (err) {
        if (isResourceMissing(err)) return { outcome: "absent" };
        throw err;
      }
      return { outcome: "deleted" };
    }
    await stripe.invoices.voidInvoice(
      ref.invoiceId,
      {},
      { idempotencyKey: `${ref.settlementId}:void` },
    );
    return { outcome: "voided" };
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────

  async createSubscriptionCheckout(
    input: BillingCheckoutSubscriptionInput,
  ): Promise<BillingCheckoutResult> {
    const seats = input.seats ?? 1;
    const taxEnabled = automaticTaxEnabled();
    const session = await this.client().checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: seats }],
      subscription_data: { metadata: input.subscriptionMetadata },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: taxEnabled },
      // Persist the address Checkout collects back onto the customer so Stripe
      // Tax can compute on subsequent invoices/renewals.
      customer_update: taxEnabled ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createPaymentCheckout(
    input: BillingCheckoutPaymentInput,
  ): Promise<BillingCheckoutResult> {
    const taxEnabled = automaticTaxEnabled();
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      metadata: input.metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: taxEnabled },
      customer_update: taxEnabled ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createDynamicCreditCheckout(
    input: BillingCheckoutDynamicCreditInput,
  ): Promise<BillingCheckoutResult> {
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: input.priceCents,
            product_data: {
              name: "Oxagen usage credits",
              metadata: { oxagen_kind: "usage_credits" },
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        org_id: input.orgId,
        credits: String(input.grantCents),
        gross_cents: String(input.grantCents),
        discount_percent: String(input.discountPercent),
      },
      payment_intent_data: {
        metadata: {
          org_id: input.orgId,
          credits: String(input.grantCents),
          gross_cents: String(input.grantCents),
          discount_percent: String(input.discountPercent),
        },
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: automaticTaxEnabled() },
      customer_update: automaticTaxEnabled() ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createGauCheckout(
    input: BillingCheckoutGauInput,
  ): Promise<BillingCheckoutResult> {
    const taxEnabled = automaticTaxEnabled();
    // The session and the invoice it issues carry the terms the purchase was
    // priced at. The webhook grant reads them from here and nowhere else, so
    // a paid session is self-sufficient (ADR-055 §6; ARCHITECTURE.md §3.9
    // item 11).
    const metadata = {
      oxagen_kind: "gau_purchase",
      org_id: input.orgId,
      gau_quantity: String(input.quantityGau),
      block_size_gau: String(input.quantityGau / input.blocks),
      rate_per_gau_micros: input.ratePerGauMicros.toString(),
      currency: input.currency,
    };
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [
        {
          price_data: {
            currency: input.currency,
            unit_amount: input.blockPriceCents,
            product_data: {
              name: "Oxagen governed action units",
              metadata: { oxagen_kind: "gau_block" },
            },
          },
          quantity: input.blocks,
        },
      ],
      metadata,
      invoice_creation: { enabled: true, invoice_data: { metadata } },
      // Card only: a delayed-notification method (ACH, SEPA, BACS) completes
      // the session unpaid and settles later on
      // `checkout.session.async_payment_succeeded`, which the webhook does
      // not dispatch; the grant reads `payment_status` on
      // `checkout.session.completed` alone. The card Checkout collects is
      // attached to the customer for the recorder's off-session auto top-up;
      // Checkout tells the customer so.
      payment_method_types: ["card"],
      // The same metadata on the PaymentIntent, which copies it onto the
      // Charge. A `charge.refunded` reads the charge and nothing else, so
      // without this the refund cannot name the organisation that was paid —
      // the credit-pack checkout has carried it since it was written
      // (createDynamicCreditCheckout above), and this one did not (ADR-085).
      // It is not sufficient on its own: a Stripe Dispute carries its own
      // metadata, not the charge's, which is why the grant also records the
      // PaymentIntent id on the settlement.
      payment_intent_data: { setup_future_usage: "off_session", metadata },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: taxEnabled },
      customer_update: taxEnabled ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async getChargeMetadata(chargeId: string): Promise<Record<string, string>> {
    try {
      const charge = await this.client().charges.retrieve(chargeId);
      return (charge.metadata as Record<string, string>) ?? {};
    } catch (err) {
      if (stripeReadDisposition(err) === "definitive") {
        // Stripe answered: there is no such charge. Retrying cannot change
        // that, and the caller's "no metadata" branch is the correct one.
        logger.warn(
          { chargeId, err: err instanceof Error ? err.message : String(err) },
          "billing: charge cannot be read; treating as no metadata",
        );
        return {};
      }
      // A timeout, a 5xx, a rate limit or a permission we have not been granted
      // yet is NOT an answer about the charge. Returning `{}` here
      // would tell the dispute handler the charge has no organisation and
      // nothing was bought, so the dispute would be dropped and the webhook
      // marked processed for ever — the exact defect ADR-085 §5 and §8 exist
      // to prevent, reached through a failed read instead of a missing field.
      //
      // Throwing is how this codebase asks for a retry: processStripeEvent
      // re-dispatches only an event whose handler threw, and Stripe's own
      // backoff is a better retry loop than one held open inside a webhook.
      logger.error(
        { chargeId, err: err instanceof Error ? err.message : String(err) },
        "billing: charge read failed transiently; failing the webhook so it is retried",
      );
      throw err;
    }
  }

  async getCheckoutPaymentMethod(
    sessionId: string,
  ): Promise<BillingCheckoutPaymentMethod | null> {
    // Two levels deep: under `payment_intent` alone, `payment_method` is a
    // string id and carries no card details.
    const sess = await this.client().checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.payment_method"],
    });
    const pi = sess.payment_intent;
    if (!pi || typeof pi === "string") return null;
    const pm = pi.payment_method;
    if (!pm || typeof pm === "string") return null;
    return {
      id: pm.id,
      type: pm.type,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      expMonth: pm.card?.exp_month ?? null,
      expYear: pm.card?.exp_year ?? null,
    };
  }

  async getCheckoutSessionCreditPacks(
    sessionId: string,
  ): Promise<BillingCreditPackLineItem[]> {
    const stripe = this.client();
    const lineItems = await stripe.checkout.sessions
      .listLineItems(sessionId, { expand: ["data.price.product"], limit: 100 })
      .autoPagingToArray({ limit: 10_000 });

    return lineItems.flatMap((item): BillingCreditPackLineItem[] => {
      const price = item.price;
      const product = price?.product;
      const creditsStr =
        price?.metadata?.credits ??
        (product && typeof product === "object" && "metadata" in product
          ? (product as Stripe.Product).metadata?.credits
          : undefined);
      const perUnit = creditsStr ? Number.parseInt(creditsStr, 10) : 0;
      if (!Number.isFinite(perUnit) || perUnit <= 0) return [];
      return [{ creditsPerUnit: perUnit, quantity: item.quantity ?? 1 }];
    });
  }

  // ── Webhook ─────────────────────────────────────────────────────────────────

  parseWebhookEvent(rawBody: string, signature: string): BillingWebhookEvent {
    const env = requireEnv(["STRIPE_WEBHOOK_SECRET"] as const);
    const event = this.client().webhooks.constructEvent(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );

    const type = stripeEventType(event.type);
    const base = {
      providerEventId: event.id,
      apiVersion: event.api_version ?? null,
      type,
      rawPayload: event as unknown as Record<string, unknown>,
    };

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.trial_will_end": {
        const sub = event.data.object as Stripe.Subscription;
        return { ...base, subscriptionId: sub.id };
      }
      case "invoice.created":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.payment_action_required":
      case "invoice.finalized":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        const inv = event.data.object as Stripe.Invoice;
        return { ...base, invoice: stripeInvoiceToNeutral(inv) };
      }
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;
        return { ...base, dispute: stripeDisputeToNeutral(dispute) };
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        return { ...base, refundedCharge: stripeChargeToNeutral(charge) };
      }
      case "checkout.session.completed": {
        const sess = event.data.object as Stripe.Checkout.Session;
        return { ...base, checkoutSession: checkoutSessionToNeutral(sess) };
      }
      case "payment_method.attached":
      case "payment_method.detached":
      case "payment_method.updated":
      case "payment_method.automatically_updated": {
        const pm = event.data.object as Stripe.PaymentMethod;
        return { ...base, paymentMethod: stripePaymentMethodToNeutral(pm) };
      }
      default:
        return base;
    }
  }
}
