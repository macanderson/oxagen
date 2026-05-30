import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { sumTokenUsage } from "@oxagen/telemetry";

export interface CurrentPeriodUsageRow {
  metric: string;
  quantity: number;
  costMicros: bigint;
}

/**
 * Returns the rollup of billable units consumed during the active
 * subscription period for the tenant. Pulls the period bounds from
 * billing.subscriptions and the raw quantities from ClickHouse.
 * Empty array when no active subscription exists.
 */
export async function getCurrentPeriodUsage(
  orgId: string,
): Promise<CurrentPeriodUsageRow[]> {
  const d = db();
  const sub = await d.query.subscriptions.findFirst({
    where: and(
      eq(schema.subscriptions.orgId, orgId),
      eq(schema.subscriptions.status, "active"),
    ),
    columns: {
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
  });
  if (!sub) return [];

  return await sumTokenUsage({
    orgId,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
  });
}
