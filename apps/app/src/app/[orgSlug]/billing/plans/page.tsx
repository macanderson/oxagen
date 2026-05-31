import { eq, and, desc, sql } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import type { PlanRow, SubscriptionRow } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { PlansGrid } from "../plans-grid";
import { safeQuery } from "../safe-query";

export default async function BillingPlansPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

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

  const currentPlanSlug =
    subscriptionRow
      ? (plans.find((p) => p.id === subscriptionRow.planId)?.slug ?? null)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <PlansGrid
        orgSlug={orgSlug}
        currentPlanSlug={currentPlanSlug}
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
