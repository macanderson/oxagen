import { eq, and, desc, sql } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import type { CreditLedgerRow, SubscriptionRow, CreditBalanceRow } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { SubscriptionSummary } from "@/components/billing/subscription-summary";
import { CreditBalance } from "@/components/billing/credit-balance";
import { BuyCredits } from "@/components/billing/buy-credits";
import { PlansGrid } from "../plans-grid";
import { fetchPublicPlans, toPlanCards } from "../public-plans";
import { safeQuery } from "../safe-query";

const CAN_MANAGE_BILLING = new Set(["owner", "admin", "billing"]);

export default async function BillingSubscriptionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [tenant, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  // Viewer's role for billing-control gating.
  const viewerRoleRow = session?.user
    ? (
        await db()
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, tenant.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1)
      )[0] ?? null
    : null;

  const viewerRole = viewerRoleRow?.role ?? "member";
  const canManageBilling = CAN_MANAGE_BILLING.has(viewerRole);

  const plans = await fetchPublicPlans();

  const subscriptionRow = await safeQuery(
    async () =>
      (
        await db()
          .select()
          .from(schema.subscriptions)
          .where(
            and(
              eq(schema.subscriptions.orgId, tenant.id),
              sql`${schema.subscriptions.status} in ('active','trialing','past_due')`,
            ),
          )
          .orderBy(desc(schema.subscriptions.createdAt))
          .limit(1)
      )[0] ?? null,
    null as SubscriptionRow | null,
  );

  const planForSub = subscriptionRow
    ? plans.find((p) => p.id === subscriptionRow.planId)
    : null;

  const creditBalance = await safeQuery(
    async () =>
      (
        await db()
          .select()
          .from(schema.creditBalances)
          .where(eq(schema.creditBalances.orgId, tenant.id))
          .limit(1)
      )[0] ?? null,
    null as CreditBalanceRow | null,
  );

  const ledgerRows = await safeQuery(
    () =>
      db()
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.orgId, tenant.id))
        .orderBy(desc(schema.creditLedger.createdAt))
        .limit(10),
    [] as CreditLedgerRow[],
  );

  const subscription = subscriptionRow
    ? {
        publicId: subscriptionRow.publicId,
        status: subscriptionRow.status,
        planSlug: planForSub?.slug ?? "",
        planName: planForSub?.name ?? "Unknown",
        billingInterval: subscriptionRow.billingInterval as "month" | "year",
        currentPeriodStart: subscriptionRow.currentPeriodStart?.toISOString() ?? "",
        currentPeriodEnd: subscriptionRow.currentPeriodEnd?.toISOString() ?? "",
        cancelAtPeriodEnd: subscriptionRow.cancelAtPeriodEnd,
        seatCount: subscriptionRow.seatCount,
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <SubscriptionSummary
            subscription={subscription}
            orgSlug={orgSlug}
            canManageBilling={canManageBilling}
          />
        </div>
        <div className="flex flex-col gap-4">
          <CreditBalance
            balanceCents={Number(creditBalance?.balanceCents ?? 0)}
            ledger={ledgerRows.map((e) => ({
              id: e.id,
              deltaCents: Number(e.deltaCents),
              reason: e.reason,
              createdAt: e.createdAt.toISOString(),
            }))}
          />
          {canManageBilling ? <BuyCredits orgSlug={orgSlug} /> : null}
        </div>
      </div>

      <PlansGrid orgSlug={orgSlug} currentPlanSlug={subscription?.planSlug ?? null} plans={toPlanCards(plans)} />
    </div>
  );
}
