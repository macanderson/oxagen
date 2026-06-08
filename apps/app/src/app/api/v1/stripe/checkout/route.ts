import { NextResponse } from "next/server";
import { z } from "zod";
import { invoke } from "@oxagen/oxagen";
import {
  billingSubscriptionUpgradeStart,
  type BillingSubscriptionUpgradeStartOutput,
} from "@oxagen/oxagen/contracts/billing.subscription.upgrade.start";
// Side-effect import: binds every foundation handler into the shared kernel so
// invoke("billing.subscription.upgrade.start", …) resolves its handler at
// runtime. Without this, invoke() throws "No handler registered" (the type
// system cannot catch a missing side-effect import). Mirrors models-action.ts.
import "@oxagen/handlers/register";
import { loadEnv } from "@oxagen/config/env";
import { getSession } from "@/lib/session";
import { resolveOrg, assertBillingManager } from "@/lib/resolve-org";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const BodySchema = z.object({
  orgSlug: z.string(),
  planSlug: z.string(),
  interval: z.enum(["month", "year"]),
});

// Thin delegate — all Stripe logic lives in @oxagen/billing via the
// billing.subscription.upgrade.start capability handler.
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

  // Billing-management gate: starting a paid checkout requires owner/admin/
  // billing role (not mere membership). Also closes the cross-org IDOR.
  await assertBillingManager(tenant.id, session.user.id);

  const successUrl = `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/billing/subscription?status=success`;
  const cancelUrl = `${env.NEXT_PUBLIC_APP_URL}/${body.data.orgSlug}/billing/subscription?status=canceled`;

  const ctx = {
    orgId: tenant.id,
    workspaceId: ORG_ONLY_WS,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = (await invoke(
      billingSubscriptionUpgradeStart.name,
      { planSlug: body.data.planSlug, interval: body.data.interval, successUrl, cancelUrl },
      ctx,
      { surface: "api" },
    )) as BillingSubscriptionUpgradeStartOutput;
    return NextResponse.json({ url: result.checkoutUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    const status = message.includes("not found") ? 404 : message.includes("no") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
