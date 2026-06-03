import { NextResponse } from "next/server";
import { z } from "zod";
import { createUsageCreditCheckout } from "@oxagen/billing";
import { loadEnv } from "@oxagen/config/env";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  /**
   * Dollar amount of usage credits to purchase (face value), e.g. 50 for $50.
   * Minimum $5. The volume discount is applied server-side.
   */
  amountUsd: z.number().positive().min(5),
});

// Thin delegate — all Stripe logic lives in @oxagen/billing.
// Returns JSON `{ url, grantCents, priceCents, percent }`. The browser is
// redirected client-side to `url`. The webhook at apps/api deposits credits
// after payment via grantCreditPackForCheckout.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const env = loadEnv();
  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  const tenant = await resolveOrg(body.data.orgSlug);

  // Membership gate: assert the session user is a member of this org before
  // creating a Stripe checkout session on their behalf (IDOR guard).
  await assertOrgMember(tenant.id, session.user.id);

  try {
    const result = await createUsageCreditCheckout({
      orgId: tenant.id,
      grantCents: Math.round(body.data.amountUsd * 100),
      successUrl: `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/settings/billing?status=success`,
      cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/settings/billing?status=canceled`,
    });
    return NextResponse.json({
      url: result.url,
      grantCents: result.grantCents,
      priceCents: result.priceCents,
      percent: result.percent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Credit checkout failed";
    const status = message.includes("not found")
      ? 404
      : message.includes("upgrade required") || message.includes("TIER_DENIED")
        ? 402
        : message.includes("grantCents must be")
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
