import { withSystemDb, withTenantDb, schema } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
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
  const runner = opts?.system ? withSystemDb : withTenantDb;
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
        return storeCustomerId(runner, orgId, candidate, {
          keepExisting: true,
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
  // Overwrite any stale id the loop just rejected. The coalesce path would
  // keep the missing cus_… and every Checkout would keep failing.
  return storeCustomerId(runner, orgId, customerId, {
    keepExisting: settingsCustomerId === null,
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

type DbRunner = typeof withTenantDb | typeof withSystemDb;

/**
 * Persist the org's Stripe customer id. `keepExisting` uses coalesce so a
 * concurrent first write wins; otherwise the new id overwrites a stale one.
 */
async function storeCustomerId(
  runner: DbRunner,
  orgId: string,
  customerId: string,
  opts: { keepExisting: boolean },
): Promise<string> {
  const [written] = await runner((tx) =>
    tx
      .insert(schema.orgBillingSettings)
      .values({ orgId, stripeCustomerId: customerId })
      .onConflictDoUpdate({
        target: schema.orgBillingSettings.orgId,
        set: {
          stripeCustomerId: opts.keepExisting
            ? sql`coalesce(${schema.orgBillingSettings.stripeCustomerId}, excluded.stripe_customer_id)`
            : customerId,
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
  }
  return stored;
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
