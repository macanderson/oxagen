import { withSystemDb, schema } from "@oxagen/database";
import { withBillingDb } from "./internal/platform-db";
import { eq } from "drizzle-orm";

/**
 * The org's Stripe customer id as the database records it, without asking
 * Stripe and without creating one.
 *
 * `org_billing_settings.stripe_customer_id` is read first because it is the
 * authoritative id (`ensureStripeCustomer`). A subscription row is only the
 * fallback for an org whose settings column is still empty. The order
 * matters after a Stripe account cutover: `ensureStripeCustomer` replaces a
 * stale id in the settings column but leaves historical subscription rows
 * naming the previous account's customer, so a reader that asks the
 * subscription row first charges or lists against a customer the current
 * account does not have.
 *
 * Returns null when neither source names a customer.
 */
export async function readRecordedCustomerId(
  orgId: string,
  opts?: { system?: boolean },
): Promise<string | null> {
  const runner = opts?.system ? withSystemDb : withBillingDb;
  return runner(async (tx) => {
    const settings = await tx.query.orgBillingSettings.findFirst({
      where: eq(schema.orgBillingSettings.orgId, orgId),
      columns: { stripeCustomerId: true },
    });
    if (settings?.stripeCustomerId) return settings.stripeCustomerId;
    const sub = await tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.orgId, orgId),
      columns: { stripeCustomerId: true },
    });
    return sub?.stripeCustomerId ?? null;
  });
}
