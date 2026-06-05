import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { effectiveBalance, createCreditLot } from "./credits";
import { CREDIT_REASONS } from "./constants";
import { logger } from "./logger";
import { getOrgBillingSettings } from "./billing-settings";

// ---------------------------------------------------------------------------
// Low balance detection
// ---------------------------------------------------------------------------

export interface LowBalanceResult {
  low: boolean;
  balanceCents: number;
  thresholdCents: number;
}

/**
 * Returns whether the org's current effective balance is below the configured
 * low-balance threshold.
 */
export async function isLowBalance(orgId: string): Promise<LowBalanceResult> {
  const [settings, balance] = await Promise.all([
    getOrgBillingSettings(orgId),
    effectiveBalance(orgId),
  ]);

  const balanceCents = Number(balance);
  const thresholdCents = Number(settings.lowBalanceThresholdCents);

  return {
    low: balanceCents < thresholdCents,
    balanceCents,
    thresholdCents,
  };
}

// ---------------------------------------------------------------------------
// Auto-reload
// ---------------------------------------------------------------------------

export interface AutoReloadResult {
  reloaded: boolean;
  amountCents?: number;
  reason?: string;
}

/**
 * Attempt an auto-reload for the org if:
 *  1. Auto-reload is enabled in org settings.
 *  2. Effective balance < autoReloadThresholdCents.
 *  3. No reload has occurred in the last hour (idempotency window).
 *
 * On success: charges autoReloadAmountCents off-session, grants a 1-year
 * purchase credit lot (reason GRANT_AUTO_RELOAD), and sets lastAutoReloadAt.
 *
 * On charge failure: logs the error and returns { reloaded: false, reason }.
 */
export async function maybeAutoReload(orgId: string): Promise<AutoReloadResult> {
  const start = Date.now();
  const settings = await getOrgBillingSettings(orgId);

  if (!settings.autoReloadEnabled) {
    return { reloaded: false, reason: "auto_reload_disabled" };
  }

  const balance = await effectiveBalance(orgId);
  const balanceCents = Number(balance);
  const thresholdCents = Number(settings.autoReloadThresholdCents);

  if (balanceCents >= thresholdCents) {
    return { reloaded: false, reason: "balance_above_threshold" };
  }

  // Idempotency: bucket by hour — one reload per hour maximum.
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  if (settings.lastAutoReloadAt && settings.lastAutoReloadAt > hourAgo) {
    logger.debug(
      { orgId, lastAutoReloadAt: settings.lastAutoReloadAt },
      "billing: auto-reload — already reloaded within the last hour, skipping",
    );
    return { reloaded: false, reason: "reloaded_recently" };
  }

  const amountCents = Number(settings.autoReloadAmountCents);
  if (amountCents <= 0) {
    return { reloaded: false, reason: "invalid_reload_amount" };
  }

  // Resolve the Stripe customer id from the active subscription.
  const d = db();
  const subRow = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.orgId, orgId),
    columns: { stripeCustomerId: true },
  });

  if (!subRow?.stripeCustomerId) {
    logger.warn({ orgId }, "billing: auto-reload — no stripe customer found, cannot charge");
    return { reloaded: false, reason: "no_stripe_customer" };
  }

  const customerId = subRow.stripeCustomerId;

  // Determine payment method: settings override or customer default.
  let paymentMethodId: string | undefined = settings.autoReloadPaymentMethodId ?? undefined;
  if (!paymentMethodId) {
    const defaultPm = await billingProvider().getDefaultPaymentMethodId(customerId);
    paymentMethodId = defaultPm ?? undefined;
  }

  // Idempotency key bucketed by hour so the same reload doesn't double-fire
  // on a retry within the same hour window.
  const hourBucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
  const idempotencyKey = `auto_reload:${orgId}:${hourBucket}`;

  let chargeResult: Awaited<ReturnType<ReturnType<typeof billingProvider>["chargeOffSession"]>>;
  try {
    chargeResult = await billingProvider().chargeOffSession({
      customerId,
      amountCents,
      paymentMethodId,
      description: "Oxagen credit auto-reload",
      metadata: {
        org_id: orgId,
        reason: CREDIT_REASONS.GRANT_AUTO_RELOAD,
      },
      idempotencyKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { orgId, customerId, amountCents, err: message, durationMs: Date.now() - start },
      "billing: auto-reload — charge off-session failed",
    );
    return { reloaded: false, reason: message };
  }

  if (!chargeResult.succeeded) {
    logger.warn(
      { orgId, customerId, amountCents, status: chargeResult.status, durationMs: Date.now() - start },
      "billing: auto-reload — charge did not succeed",
    );
    return { reloaded: false, reason: `charge_status:${chargeResult.status}` };
  }

  // Grant a purchase credit lot expiring 1 year from now.
  const grantDate = now;
  const expiresAt = new Date(grantDate);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  await createCreditLot({
    orgId,
    amountCents: BigInt(amountCents),
    source: "purchase",
    expiresAt,
    reason: CREDIT_REASONS.GRANT_AUTO_RELOAD,
    referenceType: "payment_intent",
    referenceId: chargeResult.paymentIntentId,
  });

  // Record the reload timestamp to enforce the 1-hour idempotency window.
  await d
    .update(schema.orgBillingSettings)
    .set({ lastAutoReloadAt: now, updatedAt: now })
    .where(eq(schema.orgBillingSettings.orgId, orgId));

  logger.info(
    {
      orgId,
      customerId,
      amountCents,
      paymentIntentId: chargeResult.paymentIntentId,
      expiresAt,
      durationMs: Date.now() - start,
    },
    "billing: auto-reload — credits granted",
  );

  return { reloaded: true, amountCents };
}
