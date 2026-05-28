import { NextResponse } from "next/server";
import { z } from "zod";
import Stripe from "stripe";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { loadEnv } from "@oxagen/config/env";
import { getSession } from "@/lib/session";
import { resolveTenant } from "@/lib/resolve-tenant";

const BodySchema = z.object({
  tenantSlug: z.string(),
  planSlug: z.string(),
  interval: z.enum(["month", "year"]),
});

// Always returns JSON `{ url }`. The browser is then redirected client-
// side. Stripe webhook → apps/api keeps subscription state in sync; we
// do not write subscriptions.* here.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const env = loadEnv();
  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const tenant = await resolveTenant(body.data.tenantSlug);
  const tables = schema as unknown as Record<string, any>;
  if (!tables.plans) return NextResponse.json({ error: "Billing not configured" }, { status: 503 });

  const [plan] = await db().select().from(tables.plans).where(eq(tables.plans.slug, body.data.planSlug)).limit(1);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const priceId = body.data.interval === "month" ? plan.stripePriceIdMonthly : plan.stripePriceIdAnnual;
  if (!priceId) return NextResponse.json({ error: "Price unavailable" }, { status: 400 });

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-09-30.acacia" as Stripe.LatestApiVersion });

  const existingSub = tables.subscriptions
    ? (
        await db()
          .select()
          .from(tables.subscriptions)
          .where(
            and(
              eq(tables.subscriptions.tenantId, tenant.id),
              sql`${tables.subscriptions.status} in ('active','trialing','past_due')`,
            ),
          )
          .limit(1)
      )[0]
    : null;

  const stripeSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer: existingSub?.stripeCustomerId,
    customer_email: existingSub ? undefined : session.user.email,
    success_url: `${env.NEXT_PUBLIC_APP_URL}/${body.data.tenantSlug}/settings/billing?status=success`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/${body.data.tenantSlug}/settings/billing?status=canceled`,
    client_reference_id: tenant.id,
    metadata: { tenantId: tenant.id, planId: plan.id, interval: body.data.interval },
    subscription_data: { metadata: { tenantId: tenant.id, planId: plan.id } },
  });

  if (!stripeSession.url) return NextResponse.json({ error: "No checkout URL" }, { status: 500 });
  return NextResponse.json({ url: stripeSession.url });
}
