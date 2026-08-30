import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";

/**
 * Idempotent. Returns an existing stripe_customer_id taken from ONE of the
 * org's subscription rows, or creates a new provider customer with
 * metadata.org_id and returns its id. Caller may persist the id on a
 * subscription row at the moment a subscription is created.
 *
 * NOTE: the lookup below has no ORDER BY, so when an org has more than one
 * subscription row Postgres may return any of them. That is only safe while
 * every row for an org carries the SAME stripe_customer_id — which holds today
 * because a provider customer outlives its subscriptions and is reused — but it
 * is an unenforced assumption, not a guarantee.
 */
export async function ensureStripeCustomer(orgId: string): Promise<string> {
  const { tenant, existing } = await withTenantDb(async (tx) => {
    const t = await tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, orgId),
      columns: { id: true, name: true, slug: true },
    });
    const e = await tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.orgId, orgId),
      columns: { stripeCustomerId: true },
    });
    return { tenant: t, existing: e };
  });

  if (!tenant) throw new Error(`tenant ${orgId} not found`);

  // Reuse the customer id off a subscription row, even a cancelled one —
  // provider customers persist beyond subscription lifecycles.
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const provider = billingProvider();

  // Provider customer search is eventually-consistent; the metadata lookup is
  // still cheaper than always creating duplicates when our DB row is missing.
  const found = await provider.findCustomerByOrgId(orgId);
  if (found) {
    logger.debug(
      { orgId, customerId: found.id },
      "billing: found existing customer via metadata search",
    );
    return found.id;
  }

  const customerId = await provider.createCustomer({
    name: tenant.name,
    metadata: { org_id: orgId, tenant_slug: tenant.slug },
  });
  logger.info({ orgId, customerId }, "billing: created new customer");
  return customerId;
}
