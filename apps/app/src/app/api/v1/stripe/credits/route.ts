import { NextResponse } from "next/server";
import { z } from "zod";
import { invoke } from "@oxagen/oxagen";
import {
  billingCreditsPurchase,
  type BillingCreditsPurchaseOutput,
} from "@oxagen/oxagen/contracts/billing.credits.purchase";
// Side-effect import: binds every foundation handler into the shared kernel so
// invoke("billing.credits.purchase", …) resolves its handler at runtime.
// Without this, invoke() throws "No handler registered" (the type system
// cannot catch a missing side-effect import). Mirrors models-action.ts.
import "@oxagen/handlers/register";
import { loadEnv } from "@oxagen/config/env";
import { getSession } from "@/lib/session";
import { resolveOrg, assertBillingManager } from "@/lib/resolve-org";

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  /**
   * Dollar amount of usage credits to purchase (face value), e.g. 50 for $50.
   * Minimum $5. The volume discount is applied server-side.
   */
  amountUsd: z.number().positive().min(5),
});

// Thin delegate — all Stripe logic lives in @oxagen/billing via the
// billing.credits.purchase capability handler.
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

  // Billing-management gate: spending the org's money on credits requires
  // owner/admin/billing role (not mere membership). Also closes the cross-org IDOR.
  await assertBillingManager(tenant.id, session.user.id);

  const successUrl = `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/billing/subscription?status=success`;
  const cancelUrl = `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/billing/subscription?status=canceled`;

  const ctx = {
    orgId: tenant.id,
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = (await invoke(
      billingCreditsPurchase.name,
      { amountUsd: body.data.amountUsd, successUrl, cancelUrl },
      ctx,
      { surface: "api" },
    )) as BillingCreditsPurchaseOutput;
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
