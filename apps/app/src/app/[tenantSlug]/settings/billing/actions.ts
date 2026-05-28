"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, sql, desc } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveTenant } from "@/lib/resolve-tenant";

const SubscribeSchema = z.object({
  tenantSlug: z.string(),
  planSlug: z.string(),
  interval: z.enum(["month", "year"]),
});

// We bounce through the API route rather than calling Stripe directly so
// the publishable / secret split stays inside the route handler. The
// action just brokers the checkout URL.
export async function subscribeAction(
  input: z.infer<typeof SubscribeSchema>,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await getSessionOrRedirect();
  const parsed = SubscribeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/stripe/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: text || "Stripe checkout failed" };
  }
  const json = (await res.json()) as { url: string };
  return { ok: true, url: json.url };
}

export async function cancelSubscriptionAction(input: {
  tenantSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  await getSessionOrRedirect();
  const tenant = await resolveTenant(input.tenantSlug);
  const tables = schema as unknown as Record<string, any>;
  if (!tables.subscriptions) return { ok: false, error: "Billing not configured" };

  await db()
    .update(tables.subscriptions)
    .set({ cancelAtPeriodEnd: true, canceledAt: new Date() })
    .where(
      and(
        eq(tables.subscriptions.tenantId, tenant.id),
        sql`${tables.subscriptions.status} in ('active','trialing')`,
      ),
    );

  revalidatePath(`/${input.tenantSlug}/settings/billing`);
  return { ok: true };
}

export async function reactivateSubscriptionAction(input: {
  tenantSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  await getSessionOrRedirect();
  const tenant = await resolveTenant(input.tenantSlug);
  const tables = schema as unknown as Record<string, any>;
  if (!tables.subscriptions) return { ok: false, error: "Billing not configured" };

  await db()
    .update(tables.subscriptions)
    .set({ cancelAtPeriodEnd: false, canceledAt: null })
    .where(
      and(
        eq(tables.subscriptions.tenantId, tenant.id),
        sql`${tables.subscriptions.status} in ('active','trialing','past_due')`,
      ),
    );

  revalidatePath(`/${input.tenantSlug}/settings/billing`);
  return { ok: true };
}
