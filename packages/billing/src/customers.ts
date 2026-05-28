import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { stripeClient } from "./client.js";

/**
 * Idempotent. Returns an existing stripe_customer_id from the most recent
 * subscription row for the tenant, or creates a new Stripe customer with
 * metadata.tenant_id and returns its id. Caller may persist the id on a
 * subscription row at the moment a subscription is created.
 */
export async function ensureStripeCustomer(tenantId: string): Promise<string> {
  const d = db();
  const tenant = await d.query.tenants.findFirst({
    where: eq(schema.tenants.id, tenantId),
    columns: { id: true, name: true, slug: true },
  });
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);

  // Prefer the customer id off the latest subscription, even cancelled —
  // Stripe customers persist beyond subscription lifecycles.
  const existing = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.tenantId, tenantId),
    columns: { stripeCustomerId: true },
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  // Stripe Customer search is eventually-consistent; the metadata lookup is
  // still cheaper than always creating duplicates when our DB row is missing.
  const stripe = stripeClient();
  const found = await stripe.customers.search({
    query: `metadata['tenant_id']:'${tenantId}'`,
    limit: 1,
  });
  if (found.data[0]) return found.data[0].id;

  const created = await stripe.customers.create({
    name: tenant.name,
    metadata: { tenant_id: tenantId, tenant_slug: tenant.slug },
  });
  return created.id;
}
