/**
 * Governed actions — the ADR-052 meter, made operable by a human.
 *
 * Four capabilities, one page, because they answer one question between them:
 *
 *   get_rate_card          → what a governed action costs (published price)
 *   get_action_usage       → what you have used, and what was charged
 *   preview_action_cost    → what your projected volume would cost
 *   get_evidence_retention → the second meter, and whether it is accruing
 *
 * ADR-052 replaced a cost-derived meter because it could not answer "why is my
 * bill this number". Splitting the price from the usage from the calculator
 * would reproduce that failure in navigation: the answer lives in the
 * relationship between them.
 *
 * Authorization is explicit (`resolveBillingViewer`) — `apps/app` does not
 * bootstrap kernel IAM, so `invoke()` from here would otherwise skip the role
 * check the API and MCP surfaces get for free.
 *
 * The three reads are independent: one failing renders its own panel as
 * unavailable and leaves the rest of the explanation standing.
 */

import type { Metadata } from "next";
import {
  loadActionUsage,
  loadEvidenceRetention,
  loadRateCard,
  resolveBillingViewer,
} from "./data";
import { ActionUsagePanel, MeterModeBanner } from "./action-usage-panel";
import { RateCardPanel } from "./rate-card-panel";
import { RetentionPanel } from "./retention-panel";
import { CostCalculator } from "./cost-calculator";
import { PanelUnavailable } from "./panel-unavailable";

export const metadata: Metadata = {
  title: "Governed actions",
};

export default async function GovernedActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ breakdown?: string }>;
}) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const viewer = await resolveBillingViewer(orgSlug);

  const includeBreakdown = sp.breakdown === "1";

  const [usage, rateCard, retention] = await Promise.all([
    loadActionUsage(viewer, { includeBreakdown }),
    loadRateCard(viewer),
    loadEvidenceRetention(viewer),
  ]);

  return (
    <div className="flex flex-col gap-6">
      {usage.ok ? <MeterModeBanner mode={usage.data.meterMode} /> : null}

      {usage.ok ? (
        <ActionUsagePanel usage={usage.data} />
      ) : (
        <PanelUnavailable
          title="This entitlement year"
          what="Your governed-action usage"
          detail={usage.error}
        />
      )}

      {rateCard.ok ? (
        <RateCardPanel rateCard={rateCard.data} />
      ) : (
        <PanelUnavailable
          title="Rate card"
          what="The published rate card"
          detail={rateCard.error}
        />
      )}

      <CostCalculator
        orgSlug={orgSlug}
        defaultTier={rateCard.ok ? rateCard.data.yourTier : undefined}
      />

      {retention.ok ? (
        <RetentionPanel retention={retention.data} />
      ) : (
        <PanelUnavailable
          title="Evidence retention"
          what="Your evidence-retention posture"
          detail={retention.error}
        />
      )}
    </div>
  );
}
