import { eq, and, desc, sql } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import type { CreditLedgerRow, PlanRow, SubscriptionRow, CreditBalanceRow } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { SubscriptionSummary } from "@/components/billing/subscription-summary";
import { CreditBalance } from "@/components/billing/credit-balance";
import { PlansGrid } from "../plans-grid";

export default async function BillingSubscriptionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const safeQuery = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const plans = await safeQuery(
    () => db().select().from(schema.plans).where(eq(schema.plans.isPublic, true)),
    [] as PlanRow[],
  );

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
          <SubscriptionSummary subscription={subscription} />
        </div>
        <CreditBalance
          balanceCents={Number(creditBalance?.balanceCents ?? 0)}
          ledger={ledgerRows.map((e) => ({
            id: e.id,
            deltaCents: Number(e.deltaCents),
            reason: e.reason,
            createdAt: e.createdAt.toISOString(),
          }))}
        />
      </div>

      <PlansGrid
        orgSlug={orgSlug}
        currentPlanSlug={subscription?.planSlug ?? null}
        plans={plans.map((p) => ({
          publicId: p.publicId,
          slug: p.slug,
          name: p.name,
          tier: p.tier,
          monthlyCents: p.monthlyCents,
          annualCents: p.annualCents,
          includedCreditCents: p.includedCreditCents,
          includedSeats: p.includedSeats,
          features: Array.isArray((p.features as { list?: unknown[] } | null)?.list)
            ? ((p.features as { list: unknown[] }).list as string[]).map((label) => ({ label }))
            : [],
        }))}
      />
    </div>
  );
}
