import { eq, and, desc, sql } from "drizzle-orm";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type {
  CreditLedgerRow,
  PlanRow,
  SubscriptionRow,
  CreditBalanceRow,
} from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { getSession } from "@/lib/session";
import { SubscriptionSummary } from "@/components/billing/subscription-summary";
import { CreditBalance } from "@/components/billing/credit-balance";
import { BuyCredits } from "@/components/billing/buy-credits";
import { PaymentMethods } from "@/components/billing/payment-methods";
import { AutoReloadSettings } from "@/components/billing/auto-reload-settings";
import { LowBalanceBanner } from "@/components/billing/low-balance-banner";
import { DunningBanner } from "@/components/billing/dunning-banner";
import { PlansGrid } from "../plans-grid";
import { fetchPlanCards } from "../public-plans";
import { safeQuery } from "../safe-query";
import {
  listOrgPaymentMethods,
  getOrgBillingSettings,
  getOrgBillingStatus,
  isLowBalance,
} from "@oxagen/billing";

const CAN_MANAGE_BILLING = new Set(["owner", "admin", "billing"]);

export async function BillingSubscriptionBody({
  orgSlug,
}: {
  orgSlug: string;
}) {
  const [tenant, session] = await Promise.all([
    resolveOrg(orgSlug),
    getSession(),
  ]);

  // Batch 1: all queries keyed solely on tenant/session ids — run concurrently.
  // All org-scoped reads use sentinel workspaceId (org-only tables).
  const [
    viewerRoleRow,
    subscriptionRow,
    creditBalance,
    ledgerRows,
    publicPlans,
  ] = await Promise.all([
    // Viewer's role for billing-control gating.
    session?.user
      ? runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
          withTenantDb((tx) =>
            tx
              .select({ role: schema.orgUsers.role })
              .from(schema.orgUsers)
              .where(
                and(
                  eq(schema.orgUsers.orgId, tenant.id),
                  eq(schema.orgUsers.userId, session.user.id),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ),
        )
      : Promise.resolve(null),
    safeQuery(
      async () =>
        (
          await runInTenantScope(
            { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
            () =>
              withTenantDb((tx) =>
                tx
                  .select()
                  .from(schema.subscriptions)
                  .where(
                    and(
                      eq(schema.subscriptions.orgId, tenant.id),
                      sql`${schema.subscriptions.status} in ('active','trialing','past_due')`,
                    ),
                  )
                  .orderBy(desc(schema.subscriptions.createdAt))
                  .limit(1),
              ),
          )
        )[0] ?? null,
      null as SubscriptionRow | null,
    ),
    safeQuery(
      async () =>
        (
          await runInTenantScope(
            { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
            () =>
              withTenantDb((tx) =>
                tx
                  .select()
                  .from(schema.creditBalances)
                  .where(eq(schema.creditBalances.orgId, tenant.id))
                  .limit(1),
              ),
          )
        )[0] ?? null,
      null as CreditBalanceRow | null,
    ),
    safeQuery(
      () =>
        runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
          withTenantDb((tx) =>
            tx
              .select()
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.orgId, tenant.id))
              .orderBy(desc(schema.creditLedger.createdAt))
              .limit(10),
          ),
        ),
      [] as CreditLedgerRow[],
    ),
    fetchPlanCards(),
  ]);

  const viewerRole = viewerRoleRow?.role ?? "member";
  const canManageBilling = CAN_MANAGE_BILLING.has(viewerRole);

  // Batch 2: billing-package queries and plan resolution — can run concurrently
  // since they don't depend on each other, only on tenant.id.
  const [
    planForSub,
    paymentMethods,
    billingSettings,
    billingStatus,
    lowBalanceResult,
  ] = await Promise.all([
    subscriptionRow
      ? safeQuery(
          // billing.plans is a shared platform catalog (no per-tenant rows);
          // withSystemDb bypasses RLS deliberately.
          async () =>
            (
              await withSystemDb((tx) =>
                tx
                  .select()
                  .from(schema.plans)
                  .where(eq(schema.plans.id, subscriptionRow.planId))
                  .limit(1),
              )
            )[0] ?? null,
          null as PlanRow | null,
        )
      : Promise.resolve(null),
    safeQuery(
      () =>
        runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
          listOrgPaymentMethods(tenant.id),
        ),
      [],
    ),
    canManageBilling
      ? safeQuery(
          () =>
            runInTenantScope(
              { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
              () => getOrgBillingSettings(tenant.id),
            ),
          null,
        )
      : Promise.resolve(null),
    safeQuery(
      () =>
        runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
          getOrgBillingStatus(tenant.id),
        ),
      null,
    ),
    safeQuery(
      () =>
        runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
          isLowBalance(tenant.id),
        ),
      null,
    ),
  ]);

  const subscription = subscriptionRow
    ? {
        publicId: subscriptionRow.publicId,
        status: subscriptionRow.status,
        planSlug: planForSub?.slug ?? "",
        planName: planForSub?.name ?? "Unknown",
        billingInterval: subscriptionRow.billingInterval as "month" | "year",
        currentPeriodStart:
          subscriptionRow.currentPeriodStart?.toISOString() ?? "",
        currentPeriodEnd: subscriptionRow.currentPeriodEnd?.toISOString() ?? "",
        cancelAtPeriodEnd: subscriptionRow.cancelAtPeriodEnd,
        seatCount: subscriptionRow.seatCount,
      }
    : null;

  // planForSub already resolved the plan row by subscriptionRow.planId — reuse its slug.
  // No active subscription ⇒ the org is on the Free tier (the implicit baseline),
  // so paid plans render as "Upgrade" and the current plan reads as "Free".
  const currentPlanSlug = planForSub?.slug ?? null;
  const currentTier = planForSub?.tier ?? "free";

  // Default card for display inside SubscriptionSummary.
  const defaultCard = paymentMethods.find((pm) => pm.isDefault) ?? null;

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  return (
    <div className="flex flex-col gap-6">
      {/* Dunning banner — only when not active */}
      {billingStatus && billingStatus.state !== "active" ? (
        <DunningBanner orgSlug={orgSlug} status={billingStatus} />
      ) : null}

      {/* Low-balance banner */}
      {lowBalanceResult?.low ? (
        <LowBalanceBanner
          orgSlug={orgSlug}
          balanceCents={lowBalanceResult.balanceCents}
          thresholdCents={lowBalanceResult.thresholdCents}
        />
      ) : null}

      {/* Subscription summary + credits sidebar */}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <SubscriptionSummary
            subscription={subscription}
            orgSlug={orgSlug}
            canManageBilling={canManageBilling}
            defaultCard={
              defaultCard &&
              defaultCard.brand !== null &&
              defaultCard.last4 !== null &&
              defaultCard.expMonth !== null &&
              defaultCard.expYear !== null
                ? {
                    brand: defaultCard.brand,
                    last4: defaultCard.last4,
                    expMonth: defaultCard.expMonth,
                    expYear: defaultCard.expYear,
                  }
                : null
            }
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
          {/* id is the scroll target for LowBalanceBanner's "Buy credits" CTA
              — a Server Component can't hand it a callback, so the banner
              falls back to this anchor (same shape as #payment-methods). */}
          {canManageBilling ? (
            <div id="buy-credits">
              <BuyCredits orgSlug={orgSlug} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Plan cards — upgrade / downgrade in-place */}
      <PlansGrid
        orgSlug={orgSlug}
        currentPlanSlug={currentPlanSlug}
        currentTier={currentTier}
        plans={publicPlans}
      />

      {/* Payment methods management */}
      <div id="payment-methods">
        <PaymentMethods
          orgSlug={orgSlug}
          methods={paymentMethods}
          publishableKey={publishableKey}
          canManage={canManageBilling}
        />
      </div>

      {/* Auto-reload settings */}
      {canManageBilling && billingSettings ? (
        <AutoReloadSettings
          orgSlug={orgSlug}
          settings={billingSettings}
          methods={paymentMethods}
          canManage={canManageBilling}
          hasActiveSubscription={!!subscriptionRow}
        />
      ) : null}
    </div>
  );
}
