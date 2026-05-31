"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { cancelOrgSubscription, reactivateOrgSubscription } from "@oxagen/billing";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";

const SubscribeSchema = z.object({
  orgSlug: z.string(),
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
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);
  try {
    await cancelOrgSubscription(tenant.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cancel failed" };
  }
  revalidatePath(`/${input.orgSlug}/settings/billing`);
  return { ok: true };
}

export async function reactivateSubscriptionAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);
  try {
    await reactivateOrgSubscription(tenant.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Reactivate failed" };
  }
  revalidatePath(`/${input.orgSlug}/settings/billing`);
  return { ok: true };
}
