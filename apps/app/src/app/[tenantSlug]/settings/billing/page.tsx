import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveTenant } from "@/lib/resolve-tenant";
import { SubscriptionSummary } from "@/components/billing/subscription-summary";
import { InvoiceList } from "@/components/billing/invoice-list";
import { UsageChart } from "@/components/billing/usage-chart";
import { CreditBalance } from "@/components/billing/credit-balance";
import { PlansGrid } from "./plans-grid";

export default async function BillingPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const tenant = await resolveTenant(tenantSlug);

  const tables = schema as unknown as Record<string, any>;

  // Billing tables come from a sibling subagent's schema deliverable. We
  // tolerate their temporary absence so the layout renders during
  // foundational scaffolding without crashing the page.
  const safeQuery = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const plans = await safeQuery(
    async () =>
      tables.plans
        ? await db().select().from(tables.plans).where(eq(tables.plans.isPublic, true))
        : [],
    [] as any[],
  );

  const subscriptionRow = await safeQuery(
    async () =>
      tables.subscriptions
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
              .orderBy(desc(tables.subscriptions.createdAt))
              .limit(1)
          )[0]
        : null,
    null as any,
  );

  const planForSub = subscriptionRow
    ? plans.find((p: any) => p.id === subscriptionRow.planId)
    : null;

  const invoiceRows = await safeQuery(
    async () =>
      tables.invoices
        ? await db()
            .select()
            .from(tables.invoices)
            .where(eq(tables.invoices.tenantId, tenant.id))
            .orderBy(desc(tables.invoices.createdAt))
            .limit(25)
        : [],
    [] as any[],
  );

  const creditBalance = await safeQuery(
    async () =>
      tables.creditBalances
        ? (
            await db()
              .select()
              .from(tables.creditBalances)
              .where(eq(tables.creditBalances.tenantId, tenant.id))
              .limit(1)
          )[0]
        : null,
    null as any,
  );

  const ledgerRows = await safeQuery(
    async () =>
      tables.creditLedger
        ? await db()
            .select()
            .from(tables.creditLedger)
            .where(eq(tables.creditLedger.tenantId, tenant.id))
            .orderBy(desc(tables.creditLedger.createdAt))
            .limit(10)
        : [],
    [] as any[],
  );

  const subscription = subscriptionRow
    ? {
        publicId: subscriptionRow.publicId,
        status: subscriptionRow.status,
        planSlug: planForSub?.slug ?? "",
        planName: planForSub?.name ?? "Unknown",
        billingInterval: subscriptionRow.billingInterval as "month" | "year",
        currentPeriodStart: subscriptionRow.currentPeriodStart?.toISOString?.() ?? subscriptionRow.currentPeriodStart,
        currentPeriodEnd: subscriptionRow.currentPeriodEnd?.toISOString?.() ?? subscriptionRow.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptionRow.cancelAtPeriodEnd,
        seatCount: subscriptionRow.seatCount,
      }
    : null;

  const usage = {
    periodStart: subscription?.currentPeriodStart ?? new Date().toISOString(),
    periodEnd: subscription?.currentPeriodEnd ?? new Date().toISOString(),
    metrics: [] as { metric: string; quantity: number; totalCostMicros: number }[],
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Plans, subscription, usage, and credits.</p>
      </header>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <SubscriptionSummary subscription={subscription} />
        </div>
        <CreditBalance
          balanceCents={Number(creditBalance?.balanceCents ?? 0)}
          ledger={ledgerRows.map((e: any) => ({
            publicId: e.publicId,
            deltaCents: Number(e.deltaCents),
            reason: e.reason,
            createdAt: e.createdAt?.toISOString?.() ?? e.createdAt,
          }))}
        />
      </div>

      <UsageChart usage={usage} />

      <PlansGrid
        tenantSlug={tenantSlug}
        currentPlanSlug={subscription?.planSlug ?? null}
        plans={plans.map((p: any) => ({
          publicId: p.publicId,
          slug: p.slug,
          name: p.name,
          tier: p.tier,
          monthlyCents: p.monthlyCents,
          annualCents: p.annualCents,
          includedCreditCents: p.includedCreditCents,
          includedSeats: p.includedSeats,
          features: Array.isArray(p.features?.list) ? p.features.list : [],
        }))}
      />

      <InvoiceList
        invoices={invoiceRows.map((i: any) => ({
          publicId: i.publicId,
          number: i.number,
          status: i.status,
          amountDueCents: i.amountDueCents,
          currency: i.currency,
          periodStart: i.periodStart?.toISOString?.() ?? i.periodStart,
          periodEnd: i.periodEnd?.toISOString?.() ?? i.periodEnd,
          hostedInvoiceUrl: i.hostedInvoiceUrl,
          invoicePdfUrl: i.invoicePdfUrl,
          paidAt: i.paidAt?.toISOString?.() ?? null,
        }))}
      />
    </div>
  );
}
