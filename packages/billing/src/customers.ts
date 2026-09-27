import { withSystemDb, schema } from "@oxagen/database";
import { withBillingDb } from "./internal/platform-db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";

/**
 * The org's provider customer id, created once (ADR-055 §5,
 * apps/app/ARCHITECTURE.md §3.9).
 *
 * `org_billing_settings.stripe_customer_id` is the authoritative id. It is
 * read first; when it is unset the id is taken from one of the org's
 * subscription rows, then from the provider's metadata search, and finally
 * a new customer is created — and whichever answered, the column is written
 * with `INSERT … ON CONFLICT (org_id) DO UPDATE`, keeping an id a concurrent
 * caller wrote first. The column exists because the metadata search is
 * eventually consistent: two quick purchases by a subscription-less org
 * would each create a customer without it.
 *
 * A stored id is verified against the live Stripe account before it is
 * returned. After a key rotation onto a different account (the 2026-09-13
 * sandbox cutover, docs/ops/stripe-sandbox-mode.md), rows still naming the
 * previous account's `cus_…` make every Checkout fail with
 * `resource_missing`. Those ids are dropped and a customer is re-created
 * on the account the secret key points at.
 *
 * When the replacement lands, `storeCustomerId` also retires the org's
 * saved payment methods and auto-reload override that named the previous
 * customer (`retireStaleCustomerData`), so `readDefaultPaymentMethod` and
 * `maybeAutoReload` never combine the new customer id with an old `pm_…`
 * from the account it was replaced on.
 *
 * `opts.system` routes the reads and the write through `withSystemDb` for
 * callers with no tenant scope — the close job and the platform-operator
 * handler — the switch `getOrgBillingSettings` carries. Request paths leave
 * it unset so RLS stays load-bearing.
 *
 * The subscription lookup has no ORDER BY, so an org with several
 * subscription rows may answer with any of them. That is safe while every
 * row for an org carries the same customer id, which holds because a
 * provider customer outlives its subscriptions and is reused, but it is an
 * unenforced assumption.
 */
export async function ensureStripeCustomer(
  orgId: string,
  opts?: { system?: boolean },
): Promise<string> {
  const runner = opts?.system ? withSystemDb : withBillingDb;
  const { tenant, settingsCustomerId, subscriptionCustomerId } = await runner(
    async (tx) => {
      const [t, settings, sub] = await Promise.all([
        tx.query.organizations.findFirst({
          where: eq(schema.organizations.id, orgId),
          columns: { id: true, name: true, slug: true },
        }),
        tx.query.orgBillingSettings.findFirst({
          where: eq(schema.orgBillingSettings.orgId, orgId),
          columns: { stripeCustomerId: true },
        }),
        tx.query.subscriptions.findFirst({
          where: eq(schema.subscriptions.orgId, orgId),
          columns: { stripeCustomerId: true },
        }),
      ]);
      return {
        tenant: t,
        settingsCustomerId: settings?.stripeCustomerId ?? null,
        subscriptionCustomerId: sub?.stripeCustomerId ?? null,
      };
    },
  );

  if (!tenant) throw new Error(`tenant ${orgId} not found`);

  const provider = billingProvider();
  const candidates = uniqueIds(settingsCustomerId, subscriptionCustomerId);
  for (const candidate of candidates) {
    if (await provider.customerExists(candidate)) {
      if (candidate !== settingsCustomerId) {
        // The settings row's own id (if any) is known bad: it either read
        // null or it just failed customerExists above. Compare-and-swap on
        // that value so we replace the stale id with this live one, but
        // still defer to a concurrent writer that already moved the row on.
        return storeCustomerId(runner, orgId, candidate, {
          previousValue: settingsCustomerId,
        });
      }
      return candidate;
    }
    logger.warn(
      { orgId, customerId: candidate },
      "billing: stored Stripe customer is missing on this account; recreating",
    );
  }

  const customerId = await resolveOrCreateCustomer(tenant);
  // Compare-and-swap on the settings value this call read. A concurrent
  // caller that already replaced the same stale id wins; this call then
  // returns that winner instead of splitting the org across two customers.
  return storeCustomerId(runner, orgId, customerId, {
    previousValue: settingsCustomerId,
  });
}

function uniqueIds(
  ...ids: Array<string | null | undefined>
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

type DbRunner = typeof withBillingDb | typeof withSystemDb;

/**
 * Persist the org's Stripe customer id with a compare-and-swap on
 * `opts.previousValue`, the settings value this call read before deciding
 * `customerId` was the right replacement (null, or a stale id that just
 * failed `customerExists`). The row is only overwritten while it still
 * holds that same previous value; a concurrent caller that already moved
 * the row on (to any id, not necessarily this one) wins, and that winner
 * is returned instead of being clobbered.
 *
 * When the CAS wins and replaces a *different*, non-null previous customer
 * id, that previous id belonged to another Stripe account (a sandbox
 * cutover or key rotation, see the module docstring). Its payment methods
 * and any explicit auto-reload override now point at cards Stripe will
 * reject once combined with the new customer id, so {@link
 * retireStaleCustomerData} soft-deletes them and clears the override.
 */
async function storeCustomerId(
  runner: DbRunner,
  orgId: string,
  customerId: string,
  opts: { previousValue: string | null },
): Promise<string> {
  const [written] = await runner((tx) =>
    tx
      .insert(schema.orgBillingSettings)
      .values({ orgId, stripeCustomerId: customerId })
      .onConflictDoUpdate({
        target: schema.orgBillingSettings.orgId,
        set: {
          stripeCustomerId: sql`case when ${schema.orgBillingSettings.stripeCustomerId} is not distinct from ${opts.previousValue} then excluded.stripe_customer_id else ${schema.orgBillingSettings.stripeCustomerId} end`,
          updatedAt: new Date(),
        },
      })
      .returning({
        stripeCustomerId: schema.orgBillingSettings.stripeCustomerId,
      }),
  );
  const stored = written?.stripeCustomerId ?? customerId;
  if (stored !== customerId) {
    logger.info(
      { orgId, customerId: stored, superseded: customerId },
      "billing: a concurrent caller stored the org's customer id first",
    );
    return stored;
  }
  if (opts.previousValue && opts.previousValue !== customerId) {
    await retireStaleCustomerData(runner, orgId, opts.previousValue);
  }
  return stored;
}

/**
 * Soft-delete the org's `billing.payment_methods` rows recorded against
 * `staleCustomerId` and clear a matching `auto_reload_payment_method_id`
 * override, once {@link storeCustomerId} has confirmed the org's Stripe
 * customer moved off that id.
 *
 * Both readers of a saved payment method, `readDefaultPaymentMethod` (the
 * GAU recorder) and `maybeAutoReload`, key off the org's current customer
 * id. A row or override still naming the replaced account combines with
 * the new customer id into a `pm_...` Stripe does not recognise, and the
 * top-up fails with `resource_missing`. Retiring both here, at the moment
 * the swap lands, keeps every later read consistent without asking either
 * reader to re-verify against Stripe.
 */
async function retireStaleCustomerData(
  runner: DbRunner,
  orgId: string,
  staleCustomerId: string,
): Promise<void> {
  const now = new Date();
  await runner((tx) =>
    tx
      .update(schema.paymentMethods)
      .set({ deletedAt: now, isDefault: false, updatedAt: now })
      .where(
        and(
          eq(schema.paymentMethods.orgId, orgId),
          eq(schema.paymentMethods.stripeCustomerId, staleCustomerId),
          isNull(schema.paymentMethods.deletedAt),
        ),
      ),
  );
  await runner((tx) =>
    tx
      .update(schema.orgBillingSettings)
      .set({ autoReloadPaymentMethodId: null, updatedAt: now })
      .where(eq(schema.orgBillingSettings.orgId, orgId)),
  );
  logger.warn(
    { orgId, staleCustomerId },
    "billing: retired payment methods and cleared the auto-reload override for a replaced Stripe customer",
  );
}

async function resolveOrCreateCustomer(tenant: {
  id: string;
  name: string;
  slug: string;
}): Promise<string> {
  const provider = billingProvider();

  // Provider customer search is eventually-consistent; the metadata lookup is
  // still cheaper than always creating duplicates when our DB row is missing.
  const found = await provider.findCustomerByOrgId(tenant.id);
  if (found) {
    // A search hit can still be from a previous account's index lag, or a
    // deleted customer Stripe has not purged from search. Verify before reuse.
    if (await provider.customerExists(found.id)) {
      logger.debug(
        { orgId: tenant.id, customerId: found.id },
        "billing: found existing customer via metadata search",
      );
      return found.id;
    }
    logger.warn(
      { orgId: tenant.id, customerId: found.id },
      "billing: metadata search returned a customer missing on this account; creating a new one",
    );
  }

  const customerId = await provider.createCustomer({
    name: tenant.name,
    metadata: { org_id: tenant.id, tenant_slug: tenant.slug },
  });
  logger.info(
    { orgId: tenant.id, customerId },
    "billing: created new customer",
  );
  return customerId;
}
