import { NextResponse } from "next/server";
import { z } from "zod";
import { createCheckoutSession } from "@oxagen/billing";
import { loadEnv } from "@oxagen/config/env";
import { getSession } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";

const BodySchema = z.object({
  orgSlug: z.string(),
  planSlug: z.string(),
  interval: z.enum(["month", "year"]),
});

// Thin delegate — all Stripe logic lives in @oxagen/billing.
// Always returns JSON `{ url }`. The browser is then redirected client-
// side. Stripe webhook → apps/api keeps subscription state in sync; we
// do not write subscriptions.* here.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const env = loadEnv();
  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const tenant = await resolveOrg(body.data.orgSlug);

  try {
    const { url } = await createCheckoutSession({
      orgId: tenant.id,
      planSlug: body.data.planSlug,
      interval: body.data.interval,
      successUrl: `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/settings/billing?status=success`,
      cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/settings/billing?status=canceled`,
    });
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    const status = message.includes("not found") ? 404 : message.includes("no") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
