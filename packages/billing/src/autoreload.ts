import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import {
  notifyOrgManagers,
  lowBalanceAlertTemplate,
} from "@oxagen/notifications";
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
 *
 * `opts.system` runs the underlying billing reads through withSystemDb (no
 * active tenant scope required) — for trusted cross-tenant crons like
 * billing.dunning-sweep that sweep every org. Request-path callers (e.g.
 * auto-reload during a metered turn) omit it so the reads stay RLS-enforced
 * under the active scope.
 */
export async function isLowBalance(
  orgId: string,
  opts?: { system?: boolean },
): Promise<LowBalanceResult> {
  const [settings, balance] = await Promise.all([
    getOrgBillingSettings(orgId, opts),
    effectiveBalance(orgId, opts),
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
export async function maybeAutoReload(
  orgId: string,
): Promise<AutoReloadResult> {
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

  // Resolve the Stripe customer id from one of the org's subscription rows.
  // There is no status filter and no ORDER BY here, so an org with several
  // subscription rows may resolve any of them — safe only while every row for
  // an org shares the same stripe_customer_id (see ensureStripeCustomer).
  const subRow = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.orgId, orgId),
      columns: { stripeCustomerId: true },
    }),
  );

  if (!subRow?.stripeCustomerId) {
    logger.warn(
      { orgId },
      "billing: auto-reload — no stripe customer found, cannot charge",
    );
    return { reloaded: false, reason: "no_stripe_customer" };
  }

  const customerId = subRow.stripeCustomerId;

  // Determine payment method: settings override or customer default.
  let paymentMethodId: string | undefined =
    settings.autoReloadPaymentMethodId ?? undefined;
  if (!paymentMethodId) {
    const defaultPm =
      await billingProvider().getDefaultPaymentMethodId(customerId);
    paymentMethodId = defaultPm ?? undefined;
  }

  // Idempotency key bucketed by hour so the same reload doesn't double-fire
  // on a retry within the same hour window.
  const hourBucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
  const idempotencyKey = `auto_reload:${orgId}:${hourBucket}`;

  let chargeResult: Awaited<
    ReturnType<ReturnType<typeof billingProvider>["chargeOffSession"]>
  >;
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
      {
        orgId,
        customerId,
        amountCents,
        err: message,
        durationMs: Date.now() - start,
      },
      "billing: auto-reload — charge off-session failed",
    );
    return { reloaded: false, reason: message };
  }

  if (!chargeResult.succeeded) {
    logger.warn(
      {
        orgId,
        customerId,
        amountCents,
        status: chargeResult.status,
        durationMs: Date.now() - start,
      },
      "billing: auto-reload — charge did not succeed",
    );
    return { reloaded: false, reason: `charge_status:${chargeResult.status}` };
  }

  // ── Grant credits for the successful charge ────────────────────────────────
  // CRITICAL ordering note: the card has ALREADY been charged at this point.
  // If the grant write fails we must NOT throw (that would both crash the
  // caller's turn AND leave the customer charged-but-uncredited). Instead we
  // log a critical alert with the paymentIntentId and DON'T stamp
  // lastAutoReloadAt — so the next turn (within the same hour idempotency
  // window) retries the grant against the same, de-duplicated charge and
  // self-heals, while ops has the paymentIntentId to compensate if it doesn't.
  //
  // One failure below is BENIGN, and the alert cannot tell it apart: two
  // concurrent turns can both pass the lastAutoReloadAt check, both send the
  // same idempotencyKey (so Stripe charges once), and both then try to grant
  // against the same paymentIntentId. The credit_ledger idempotency index
  // rejects the second insert, which lands here as "grant_failed_after_charge"
  // even though the racer already granted the credits correctly. Check the
  // ledger for the paymentIntentId before compensating on this alert.
  const grantDate = now;
  const expiresAt = new Date(grantDate);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  try {
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
    await withTenantDb((tx) =>
      tx
        .update(schema.orgBillingSettings)
        .set({ lastAutoReloadAt: now, updatedAt: now })
        .where(eq(schema.orgBillingSettings.orgId, orgId)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        orgId,
        customerId,
        amountCents,
        paymentIntentId: chargeResult.paymentIntentId,
        err: message,
        durationMs: Date.now() - start,
        alert: "auto_reload_charged_but_not_granted",
      },
      "billing: auto-reload — CHARGED but credit grant failed; customer charged without credits, needs reconciliation (retries next turn)",
    );
    return { reloaded: false, reason: "grant_failed_after_charge" };
  }

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

// ---------------------------------------------------------------------------
// Low-balance notification
// ---------------------------------------------------------------------------

/**
 * Send a low-balance alert to org managers (owners/admins) via in-app
 * notification + email. This is a best-effort operation: failures are logged
 * but never propagated (billing operations must not fail due to notification
 * issues).
 */
export async function notifyLowBalance(
  orgId: string,
  result: LowBalanceResult,
): Promise<void> {
  if (!result.low) return;
  try {
    // Resolve the human-readable org name from the database.
    const orgRow = await withSystemDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.id, orgId),
        columns: { name: true },
      }),
    );
    const orgName = orgRow?.name ?? "your organization";

    const appUrl = process.env["APP_URL"] ?? "https://app.oxagen.sh";
    const topUpUrl = `${appUrl}/settings/billing/credits`;
    const template = lowBalanceAlertTemplate({
      orgName,
      balanceCents: result.balanceCents,
      thresholdCents: result.thresholdCents,
      topUpUrl,
    });
    await notifyOrgManagers({
      orgId,
      kind: "system",
      title: template.subject,
      body: template.text,
      emailHtml: template.html,
      deepLink: "/settings/billing/credits",
    });
  } catch (err) {
    logger.warn(
      { orgId, err },
      "billing: low-balance notification failed (non-fatal)",
    );
  }
}
