import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";

/**
 * Idempotent. Returns an existing stripe_customer_id from the most recent
 * subscription row for the tenant, or creates a new provider customer with
 * metadata.org_id and returns its id. Caller may persist the id on a
 * subscription row at the moment a subscription is created.
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

  // Prefer the customer id off the latest subscription, even cancelled —
  // provider customers persist beyond subscription lifecycles.
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const provider = billingProvider();

  // Provider customer search is eventually-consistent; the metadata lookup is
  // still cheaper than always creating duplicates when our DB row is missing.
  const found = await provider.findCustomerByOrgId(orgId);
  if (found) {
    logger.debug({ orgId, customerId: found.id }, "billing: found existing customer via metadata search");
    return found.id;
  }

  const customerId = await provider.createCustomer({
    name: tenant.name,
    metadata: { org_id: orgId, tenant_slug: tenant.slug },
  });
  logger.info({ orgId, customerId }, "billing: created new customer");
  return customerId;
}
