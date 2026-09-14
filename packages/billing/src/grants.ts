import { withTenantDb, withSystemDb, schema, type Tx } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, sql } from "drizzle-orm";
import { deterministicUuid } from "./internal/deterministic-uuid";
import { billingProvider } from "./client";
import { syncSubscriptionFromStripe } from "./subscriptions";
import { syncInvoiceFromStripe } from "./invoices";
import { CREDIT_REASONS } from "./constants";
import { logger } from "./logger";
import type { BillingCheckoutSession, BillingInvoice } from "./provider";

/**
 * The grant half of the credit loop: payments deposit credits into lots, the
 * gate ({@link import("./metering").chargeUsageCredits}) spends them.
 * All grants go through a single transaction that:
 *  1. INSERT INTO credit_ledger … ON CONFLICT DO NOTHING  ← atomic idempotency
 *  2. INSERT INTO credit_lots
 *  3. Upsert credit_balances
 *
 * The ON CONFLICT DO NOTHING on step 1 requires the partial UNIQUE index on
 * credit_ledger(org_id, reason, reference_type, reference_id) declared in
 * schema/billing.ts. It is what makes a grant idempotent under concurrent
 * webhook deliveries; without it every insert succeeds and double-grants.
 *
 * EXPIRY RULES:
 *   free_grant   → expires_at NULL (never expires; used for signup grants too)
 *   subscription → expires_at = end of the grant month (use-it-or-lose-it)
 *   purchase     → expires_at = granted_at + 1 year
 */

const SUBSCRIPTION_GRANT_REASONS: ReadonlySet<string> = new Set([
  "subscription_create",
  "subscription_cycle",
]);

/** Drizzle transaction type alias — uses the Tx type from @oxagen/database. */
type DbTx = Tx;

/**
 * Attempt to insert the grant ledger row atomically.
 *
 * Returns true when the row was inserted (grant not yet applied) and false when
 * it conflicted (already granted). A conflict means another request already
 * landed the same (org_id, reason, reference_type, reference_id) combination.
 *
 * Atomicity depends on the partial UNIQUE index
 *   credit_ledger_grant_idempotency_idx
 *   ON credit_ledger(org_id, reason, reference_type, reference_id)
 *   WHERE reference_type IS NOT NULL
 *     AND reference_id IS NOT NULL
 *     AND reason LIKE 'grant_%'
 * declared in the Drizzle schema (schema/billing.ts). ON CONFLICT DO NOTHING
 * uses it as the arbiter; without it every insert would succeed and
 * duplicate-grant.
 *
 * The `reason LIKE 'grant_%'` half of that predicate is load-bearing for THIS
 * function: a `reason` that does not start with `grant_` falls outside the index
 * and the insert is NOT deduplicated — it always succeeds, and the caller then
 * grants a second lot. Every reason passed here must be a CREDIT_REASONS.GRANT_*
 * value. (The predicate exists because spend rows legitimately repeat a
 * reference id — one turn makes several billable calls under one message id —
 * so constraining them would make the second debit throw and go unbilled.)
 */
async function tryInsertGrantLedger(
  tx: DbTx,
  orgId: string,
  reason: string,
  referenceType: string,
  referenceId: string,
  amountCents: bigint,
): Promise<boolean> {
  const inserted = await tx
    .insert(schema.creditLedger)
    .values({
      orgId,
      deltaCents: amountCents,
      reason,
      referenceType,
      referenceId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.creditLedger.id });

  return inserted.length > 0;
}

/**
 * Insert a credit lot and upsert the credit_balances mirror inside a running
 * transaction. Used by all grant paths after the ledger row is confirmed.
 */
async function insertLotAndMirrorBalance(
  tx: DbTx,
  orgId: string,
  source: "free_grant" | "subscription" | "purchase",
  amountCents: bigint,
  grantedAt: Date,
  expiresAt: Date | null,
): Promise<void> {
  await tx.insert(schema.creditLots).values({
    orgId,
    source,
    originalCents: amountCents,
    remainingCents: amountCents,
    grantedAt,
    expiresAt,
  });

  await tx
    .insert(schema.creditBalances)
    .values({ orgId, balanceCents: amountCents, lastEventAt: grantedAt })
    .onConflictDoUpdate({
      target: schema.creditBalances.orgId,
      set: {
        balanceCents: sql`${schema.creditBalances.balanceCents} + ${amountCents}`,
        lastEventAt: grantedAt,
        updatedAt: grantedAt,
      },
    });
}

/**
 * Returns the last moment of the month containing the given date (UTC).
 * Subscription credits expire at end-of-grant-month so unused allotments
 * don't roll over.
 */
function endOfGrantMonth(grantDate: Date): Date {
  // First day of the following month at midnight UTC, minus 1ms.
  const d = new Date(
    Date.UTC(grantDate.getUTCFullYear(), grantDate.getUTCMonth() + 1, 1),
  );
  d.setUTCMilliseconds(-1);
  return d;
}

// ---------------------------------------------------------------------------
// Free signup grant — 500 credits, never expiring
// ---------------------------------------------------------------------------

const FREE_SIGNUP_CREDITS = 500n; // 500 credits = $5.00

/**
 * Grant 500 non-expiring free credits to a newly-created org.
 * Called immediately after org creation so the org can start using the
 * platform without a payment method.
 *
 * Idempotency is enforced atomically via INSERT … ON CONFLICT DO NOTHING
 * on the credit_ledger unique key (org_id, reason, reference_type,
 * reference_id). No separate SELECT is needed.
 */
export async function grantFreeCredits(orgId: string): Promise<void> {
  const start = Date.now();
  let granted = false;

  // tenancy: system bypass via withSystemDb. grantFreeCredits runs immediately
  // after org creation (onboarding action + organizationCreateHandler), where
  // there is NO active tenant scope yet — the org-creation transaction is itself
  // a system-level write, and the orgId is supplied explicitly. Using
  // withTenantDb here throws TenantScopeError ("no_tenant_scope") under enforced
  // RLS, silently dropping the $5 signup grant. credit_* tables are org_only and
  // every write is scoped by the explicit orgId. Mirrors grantPlanCreditsForInvoicePaid
  // / grantCreditPackForCheckout.
  await withSystemDb(async (tx) => {
    granted = await tryInsertGrantLedger(
      tx,
      orgId,
      CREDIT_REASONS.GRANT_SIGNUP,
      "org",
      orgId,
      FREE_SIGNUP_CREDITS,
    );
    if (!granted) return; // Already granted — conflict, nothing to do.
    await insertLotAndMirrorBalance(
      tx,
      orgId,
      "free_grant",
      FREE_SIGNUP_CREDITS,
      new Date(),
      null,
    );
  });

  if (granted) {
    logger.info(
      {
        orgId,
        amountCents: Number(FREE_SIGNUP_CREDITS),
        durationMs: Date.now() - start,
      },
      "billing: free signup credits granted",
    );
  } else {
    logger.debug(
      { orgId },
      "billing: free signup credits already granted, skipping",
    );
  }
}

// ---------------------------------------------------------------------------
// Subscription plan credit grant (invoice.paid)
// ---------------------------------------------------------------------------

/**
 * Grant a subscription's included credits when its invoice is paid. Fires on
 * the first invoice (`subscription_create`) and every renewal
 * (`subscription_cycle`); upgrades/one-offs are ignored so we never
 * double-grant within a period.
 *
 * Subscription credits expire at the end of the calendar month in which the
 * invoice was paid (use-it-or-lose-it).
 */
export async function grantPlanCreditsForInvoicePaid(
  invoice: BillingInvoice,
): Promise<void> {
  if (
    !invoice.billingReason ||
    !SUBSCRIPTION_GRANT_REASONS.has(invoice.billingReason)
  )
    return;
  if (!invoice.subscriptionId) return;

  const start = Date.now();

  // Make sure our subscriptions row exists before resolving the plan.
  await syncSubscriptionFromStripe(invoice.subscriptionId);

  // Make sure our local invoice row exists before we key the grant on it — its
  // id IS the idempotency reference id below.
  //
  // Stripe does not guarantee webhook ordering and events are processed
  // concurrently, so invoice.paid can arrive before subscription.created. A
  // subscription invoice carries no org_id of its own (only
  // subscription_data.metadata does), so an invoice sync that runs before the
  // subscription row exists cannot resolve a tenant and writes nothing. The
  // subscription is synced just above, so re-syncing the invoice here makes its
  // row present whatever order the events arrived in. Same self-healing pattern
  // as the syncSubscriptionFromStripe call above.
  await syncInvoiceFromStripe(invoice.providerInvoiceId);

  let granted = false;

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (invoice.paid webhook has no org scope yet;
    // org resolved from Stripe subscription id before a tenant scope exists;
    // billing is org_only).
    const sub = await tx.query.subscriptions.findFirst({
      where: eq(
        schema.subscriptions.stripeSubscriptionId,
        invoice.subscriptionId!,
      ),
      columns: { orgId: true, planId: true },
    });
    if (!sub) {
      logger.warn(
        {
          stripeSubscriptionId: invoice.subscriptionId,
          invoiceId: invoice.providerInvoiceId,
        },
        "billing: plan credit grant — no subscription row found for stripe subscription id; credits not granted",
      );
      return;
    }

    const plan = await tx.query.plans.findFirst({
      where: eq(schema.plans.id, sub.planId),
      columns: { includedCreditCents: true },
    });
    const credits = plan?.includedCreditCents ?? 0;
    if (credits <= 0) {
      logger.warn(
        {
          orgId: sub.orgId,
          planId: sub.planId,
          includedCreditCents: plan?.includedCreditCents ?? null,
        },
        "billing: plan credit grant — plan has zero/null includedCreditCents; no credits granted (check plan configuration)",
      );
      return;
    }

    const invoiceRow = await tx.query.invoices.findFirst({
      where: eq(schema.invoices.stripeInvoiceId, invoice.providerInvoiceId),
      columns: { id: true },
    });
    const referenceId = invoiceRow?.id;
    if (!referenceId) {
      logger.warn(
        { orgId: sub.orgId, stripeInvoiceId: invoice.providerInvoiceId },
        "billing: plan credit grant — no local invoice row found for stripe invoice id; credits not granted (invoice may not have synced yet)",
      );
      return;
    }

    const grantDate = new Date();
    const expiresAt = endOfGrantMonth(grantDate);
    const amountCents = BigInt(credits);

    granted = await tryInsertGrantLedger(
      tx,
      sub.orgId,
      CREDIT_REASONS.GRANT_PLAN_RENEWAL,
      "stripe_invoice",
      referenceId,
      amountCents,
    );
    if (!granted) {
      logger.debug(
        { orgId: sub.orgId, referenceId },
        "billing: plan renewal credits already granted, skipping",
      );
      return;
    }
    await insertLotAndMirrorBalance(
      tx,
      sub.orgId,
      "subscription",
      amountCents,
      grantDate,
      expiresAt,
    );

    logger.info(
      {
        orgId: sub.orgId,
        amountCents: Number(amountCents),
        referenceId,
        expiresAt,
        durationMs: Date.now() - start,
      },
      "billing: plan renewal credits granted",
    );

    emitSecurityEvent({
      eventType: "billing.credits_purchased",
      actorUserId: null,
      orgId: sub.orgId,
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
  });
}

// ---------------------------------------------------------------------------
// Mid-cycle plan upgrade prorated credit grant
// ---------------------------------------------------------------------------

/**
 * Grant the prorated delta of included credits for a mid-cycle plan upgrade.
 *
 * Logic:
 *   delta = toPlan.includedCreditCents - fromPlan.includedCreditCents
 *   if delta <= 0 → no-op (downgrades / lateral moves do not grant)
 *   prorated = ceil(delta × daysRemaining / daysInPeriod)
 *   referenceId = deterministicUuid("plan_upgrade:{orgId}:{toPlanId}:{periodStart.toISOString()}")
 *
 * Idempotent: the (org_id, reason, reference_type, reference_id) ledger key
 * ensures the grant fires at most once per upgrade × period.
 */
export async function grantProratedPlanUpgradeCredits(
  orgId: string,
  fromPlanId: string,
  toPlanId: string,
): Promise<void> {
  const start = Date.now();

  // billing.plans is a shared platform catalog (no org_id, RLS not enabled) —
  // read via withSystemDb to match the catalog-read convention used in
  // grantPlanCreditsForInvoicePaid. reads/writes to credit_* tables stay on
  // withTenantDb (org_only).
  const [fromPlan, toPlan] = await withSystemDb((tx) =>
    Promise.all([
      tx.query.plans.findFirst({
        where: eq(schema.plans.id, fromPlanId),
        columns: { includedCreditCents: true },
      }),
      tx.query.plans.findFirst({
        where: eq(schema.plans.id, toPlanId),
        columns: { includedCreditCents: true },
      }),
    ]),
  );

  const fromIncluded = fromPlan?.includedCreditCents ?? 0;
  const toIncluded = toPlan?.includedCreditCents ?? 0;
  const delta = toIncluded - fromIncluded;

  if (delta <= 0) {
    logger.debug(
      { orgId, fromPlanId, toPlanId, delta },
      "billing: plan upgrade grant — no delta or downgrade, skipping",
    );
    return;
  }

  // Find the active subscription to get period bounds.
  const sub = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        sql`${schema.subscriptions.status} IN ('active','trialing')`,
      ),
      columns: { currentPeriodStart: true, currentPeriodEnd: true },
    }),
  );

  if (!sub) {
    logger.warn(
      { orgId },
      "billing: plan upgrade grant — no active subscription, skipping",
    );
    return;
  }

  const now = new Date();
  const periodStart = sub.currentPeriodStart;
  const periodEnd = sub.currentPeriodEnd;

  const msInPeriod = periodEnd.getTime() - periodStart.getTime();
  const msRemaining = periodEnd.getTime() - now.getTime();

  if (msInPeriod <= 0 || msRemaining <= 0) {
    logger.debug(
      { orgId },
      "billing: plan upgrade grant — period already ended, skipping",
    );
    return;
  }

  const daysInPeriod = msInPeriod / (1000 * 60 * 60 * 24);
  const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);
  const prorated = Math.ceil((delta * daysRemaining) / daysInPeriod);

  if (prorated <= 0) return;

  const amountCents = BigInt(prorated);
  const referenceId = deterministicUuid(
    `plan_upgrade:${orgId}:${toPlanId}:${periodStart.toISOString()}`,
  );

  // Expires end of the grant month.
  const expiresAt = endOfGrantMonth(now);

  let granted = false;
  await withTenantDb(async (tx) => {
    granted = await tryInsertGrantLedger(
      tx,
      orgId,
      CREDIT_REASONS.GRANT_PLAN_UPGRADE,
      "plan_change",
      referenceId,
      amountCents,
    );
    if (!granted) return;
    await insertLotAndMirrorBalance(
      tx,
      orgId,
      "subscription",
      amountCents,
      now,
      expiresAt,
    );
  });

  if (granted) {
    logger.info(
      {
        orgId,
        fromPlanId,
        toPlanId,
        delta,
        daysRemaining: Math.round(daysRemaining),
        prorated,
        expiresAt,
        durationMs: Date.now() - start,
      },
      "billing: prorated plan upgrade credits granted",
    );
  } else {
    logger.debug(
      { orgId, toPlanId, referenceId },
      "billing: plan upgrade credits already granted, skipping",
    );
  }
}

// ---------------------------------------------------------------------------
// Credit pack purchase grant (checkout.session.completed)
// ---------------------------------------------------------------------------

/**
 * Grant a one-time credit pack's credits when its Checkout session completes.
 * Purchase packs expire 1 year from the grant date.
 *
 * Idempotency is atomic: INSERT … ON CONFLICT DO NOTHING on the ledger row
 * keyed by (org_id, reason, "stripe_checkout_session", deterministicUuid(sessionId)).
 */
export async function grantCreditPackForCheckout(
  session: BillingCheckoutSession,
): Promise<void> {
  if (session.mode !== "payment" || session.paymentStatus !== "paid") return;
  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  const start = Date.now();
  const referenceId = deterministicUuid(
    `stripe_checkout_session:${session.id}`,
  );

  const lineItems = await billingProvider().getCheckoutSessionCreditPacks(
    session.id,
  );
  let totalCredits = 0;
  for (const item of lineItems) {
    totalCredits += item.creditsPerUnit * item.quantity;
  }

  // Dynamic credit purchases do not have a pre-created Stripe Price, so there
  // are no credits encoded in price/product metadata. The checkout session
  // itself carries `credits` (= grantCents, the face value) in its metadata.
  // Fall back to that value when line items yield nothing.
  if (totalCredits <= 0) {
    const metaCredits = session.metadata?.credits;
    if (metaCredits) {
      const parsed = Number.parseInt(metaCredits, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        totalCredits = parsed;
      }
    }
  }

  if (totalCredits <= 0) return;

  const grantDate = new Date();
  const expiresAt = new Date(grantDate);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  const amountCents = BigInt(totalCredits);

  let granted = false;
  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (checkout.session.completed webhook, orgId
    // from session metadata, no active tenant scope at webhook dispatch time).
    granted = await tryInsertGrantLedger(
      tx,
      orgId,
      CREDIT_REASONS.GRANT_CREDIT_PACK,
      "stripe_checkout_session",
      referenceId,
      amountCents,
    );
    if (!granted) return;
    await insertLotAndMirrorBalance(
      tx,
      orgId,
      "purchase",
      amountCents,
      grantDate,
      expiresAt,
    );
  });

  if (granted) {
    logger.info(
      {
        orgId,
        amountCents: Number(amountCents),
        sessionId: session.id,
        expiresAt,
        durationMs: Date.now() - start,
      },
      "billing: credit pack credits granted",
    );
    emitSecurityEvent({
      eventType: "billing.credits_purchased",
      actorUserId: null,
      orgId,
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
  } else {
    logger.debug(
      { orgId, referenceId },
      "billing: credit pack already granted, skipping",
    );
  }
}
