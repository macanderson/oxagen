import { UsageDashboard } from "./usage-dashboard";

/**
 * Usage tab — high-fidelity static mock of the billing analytics dashboard.
 * ZERO server data dependencies; all data is hardcoded mock data.
 *
 * Phase 3 will wire real per-metric usage from ClickHouse runtime events
 * (see Linear OXA-1585).
 */
export default async function BillingUsagePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  // params consumed to satisfy Next.js route contract; not used for data fetching
  // in this static mock. Live version will use orgSlug to scope ClickHouse queries.
  await params;

  return <UsageDashboard />;
}
