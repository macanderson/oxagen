import { UsageChart } from "@/components/billing/usage-chart";

/**
 * Usage tab — renders the usage chart with an empty placeholder.
 * Phase 3 will wire real per-metric usage data from ClickHouse.
 */
export default async function BillingUsagePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  // orgSlug is not needed for the stub but received for future queries.
  await params;

  const usage = {
    periodStart: new Date().toISOString(),
    periodEnd: new Date().toISOString(),
    metrics: [] as { metric: string; quantity: number; totalCostMicros: number }[],
  };

  return (
    <div className="flex flex-col gap-6">
      <UsageChart usage={usage} />
    </div>
  );
}
