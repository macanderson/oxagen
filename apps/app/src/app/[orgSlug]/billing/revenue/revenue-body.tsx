/**
 * Revenue / Reseller — the "Stripe for agents" surface. A reseller meters
 * observed agent usage per END-CUSTOMER, prices it, and pushes it to an invoice
 * in the reseller's own Stripe account. Distinct from Usage (the org's own
 * consumption) and Subscription (the org's own plan).
 *
 * All reads flow through invoke() so they are observed like every capability.
 * apps/app does not bootstrap kernel IAM, so the caller is gated explicitly here
 * (assertBillingManager) before any invoke.
 *
 * Every read is double-guarded: try/catch degrades a *rejecting* backend to the
 * panel fallback, and withTimeout degrades a *hanging* one (e.g. a stalled
 * ClickHouse aggregation behind preview_reseller_rebill) so a single slow
 * dependency can never block the whole page render.
 */

import { invoke } from "@oxagen/oxagen";
// Binds every handler into the kernel — without it invoke() throws.
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type {
  ResellerCustomer,
  ResellerPricePlan,
  ResellerAttributionRule,
  ResellerRebillRun,
  ResellerRebillPreview,
} from "@oxagen/oxagen/contracts/reseller-shared";
import { logger } from "@oxagen/handlers/logger";
import { resolveOrg, assertBillingManager } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { withTimeout } from "@/lib/with-timeout";
import { RevenueView } from "./revenue-view";

// Sentinel workspaceId for org-only routes.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

/** Current calendar month to date, in UTC — the default re-bill period. */
function currentPeriod(): { start: string; end: string; label: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const label = start.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { start: start.toISOString(), end: now.toISOString(), label };
}

export async function BillingRevenueBody({ orgSlug }: { orgSlug: string }) {
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);
  const viewerUserId = session?.user?.id ?? "";
  if (viewerUserId) {
    // Revenue is a billing surface — owner/admin/billing only (404 otherwise).
    await assertBillingManager(org.id, viewerUserId);
  }

  const period = currentPeriod();

  const ctx = {
    orgId: org.id,
    workspaceId: ORG_ONLY_WS,
    userId: viewerUserId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const data = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    async () => {
      const read = async <T,>(
        name: string,
        input: unknown,
        fallback: T,
      ): Promise<T> => {
        try {
          return await withTimeout(
            invoke(name, input, ctx, { surface: "agent" }) as Promise<T>,
            fallback,
            `billing/revenue:${name}`,
          );
        } catch (err) {
          logger.error(
            { err, orgId: org.id, capability: name },
            "billing/revenue: read failed",
          );
          return fallback;
        }
      };

      const [customers, plans, rules, stripe, runs, preview] =
        await Promise.all([
          read<{ customers: ResellerCustomer[] }>(
            "list_reseller_customers",
            {},
            { customers: [] },
          ),
          read<{ pricePlans: ResellerPricePlan[] }>(
            "list_reseller_price_plans",
            {},
            { pricePlans: [] },
          ),
          read<{ rules: ResellerAttributionRule[] }>(
            "list_reseller_attribution_rules",
            {},
            { rules: [] },
          ),
          read<{
            connected: boolean;
            accountLabel: string | null;
            keyLast4: string | null;
            updatedAt: string | null;
          }>(
            "get_reseller_stripe_status",
            {},
            {
              connected: false,
              accountLabel: null,
              keyLast4: null,
              updatedAt: null,
            },
          ),
          read<{ runs: ResellerRebillRun[] }>(
            "list_reseller_rebill_runs",
            { limit: 50 },
            { runs: [] },
          ),
          read<{
            previews: ResellerRebillPreview[];
            unattributedCostCents: number;
          }>(
            "preview_reseller_rebill",
            { start: period.start, end: period.end },
            { previews: [], unattributedCostCents: 0 },
          ),
        ]);

      return {
        customers: customers.customers,
        plans: plans.pricePlans,
        rules: rules.rules,
        stripe,
        runs: runs.runs,
        previews: preview.previews,
        unattributedCostCents: preview.unattributedCostCents,
      };
    },
  );

  return (
    <RevenueView
      orgSlug={orgSlug}
      period={period}
      customers={data.customers}
      plans={data.plans}
      rules={data.rules}
      stripe={data.stripe}
      runs={data.runs}
      previews={data.previews}
      unattributedCostCents={data.unattributedCostCents}
    />
  );
}
