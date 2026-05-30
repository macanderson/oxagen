import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { stripeClient } from "./client.js";

/**
 * Idempotent. Returns an existing stripe_customer_id from the most recent
 * subscription row for the tenant, or creates a new Stripe customer with
 * metadata.org_id and returns its id. Caller may persist the id on a
 * subscription row at the moment a subscription is created.
 */
export async function ensureStripeCustomer(orgId: string): Promise<string> {
  const d = db();
  const tenant = await d.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
    columns: { id: true, name: true, slug: true },
  });
  if (!tenant) throw new Error(`tenant ${orgId} not found`);

  // Prefer the customer id off the latest subscription, even cancelled —
  // Stripe customers persist beyond subscription lifecycles.
  const existing = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.orgId, orgId),
    columns: { stripeCustomerId: true },
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  // Stripe Customer search is eventually-consistent; the metadata lookup is
  // still cheaper than always creating duplicates when our DB row is missing.
  const stripe = stripeClient();
  const found = await stripe.customers.search({
    query: `metadata['org_id']:'${orgId}'`,
    limit: 1,
  });
  if (found.data[0]) return found.data[0].id;

  const created = await stripe.customers.create({
    name: tenant.name,
    metadata: { org_id: orgId, tenant_slug: tenant.slug },
  });
  return created.id;
}
