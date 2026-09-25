import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import { sumTokenUsage } from "@oxagen/telemetry";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "./tier";

export interface CurrentPeriodUsageRow {
  metric: string;
  quantity: number;
  costMicros: bigint;
}

/**
 * Returns the rollup of billable units consumed during the current
 * subscription period for the tenant. Pulls the period bounds from
 * billing.subscriptions and the raw quantities from ClickHouse.
 *
 * A subscription counts when its status is in
 * {@link ENTITLED_SUBSCRIPTION_STATUSES}, the list tier resolution uses. A
 * trialing or past-due org still consumes billable units, and filtering on
 * `active` alone gave those orgs an empty rollup (#2976).
 * Empty array when no entitled subscription exists.
 */
export async function getCurrentPeriodUsage(
  orgId: string,
): Promise<CurrentPeriodUsageRow[]> {
  const sub = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, orgId),
        inArray(schema.subscriptions.status, [
          ...ENTITLED_SUBSCRIPTION_STATUSES,
        ]),
      ),
      columns: {
        currentPeriodStart: true,
        currentPeriodEnd: true,
      },
    }),
  );
  if (!sub) return [];

  return await sumTokenUsage({
    orgId,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
  });
}
