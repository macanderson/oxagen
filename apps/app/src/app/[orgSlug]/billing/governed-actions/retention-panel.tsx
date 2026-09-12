/**
 * retention-panel.tsx — the second meter's posture (ADR-052 §4.3).
 *
 * Reads `get_evidence_retention`. The two fields that carry the promise:
 *
 *   - `extendedRetentionEnabled: false` reads as "nothing is accruing". Opt-in
 *     is the customer promise (spec §7.4), so the off state is stated
 *     positively rather than shown as an unset toggle the reader has to
 *     interpret.
 *   - `storedGbBeyondIncluded: null` with `storedGbMeasured: false` reads as
 *     "not measured yet". Never "0 GB" — a zero says "you are storing
 *     nothing", which is a different claim and probably a false one.
 */

import { Panel } from "@/components/ui/panel";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type { BillingEvidenceRetentionOutput } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import {
  formatCreditsUsd,
  formatRetentionWindow,
  formatStoredGb,
  formatUsdRate,
  NOT_MEASURED_LABEL,
} from "./action-meter-format";

export interface RetentionPanelProps {
  retention: BillingEvidenceRetentionOutput;
}

export function RetentionPanel({ retention }: RetentionPanelProps) {
  const enabled = retention.extendedRetentionEnabled;
  const storedLabel = formatStoredGb(
    retention.storedGbBeyondIncluded,
    retention.storedGbMeasured,
  );

  return (
    <Panel
      title="Evidence retention"
      eyebrow="Second meter"
      actions={
        <Badge variant={enabled ? "warning-soft" : "success-soft"} dot>
          {enabled ? "Extended retention on" : "Nothing accruing"}
        </Badge>
      }
    >
      <div className="flex flex-col gap-5">
        <StatGroup columns={4}>
          <Stat
            label="Included window"
            value={`${retention.includedMonths} months`}
            hint="held at no charge"
          />
          <Stat
            label="Your retention policy"
            value={formatRetentionWindow(retention.effectiveRetentionDays)}
            hint="longest window any pinned policy declares"
          />
          <Stat
            label="Held beyond included"
            value={storedLabel}
            hint={
              retention.storedGbMeasured
                ? "measured volume"
                : "the accounting job has not run for this org"
            }
            tone={retention.storedGbMeasured ? "neutral" : "warning"}
            data-testid="retention-stored-gb"
          />
          <Stat
            label="Retention charged"
            value={formatCreditsUsd(retention.creditsChargedThisPeriod)}
            hint="this entitlement year"
          />
        </StatGroup>

        {enabled ? (
          <Alert variant="warning" data-testid="retention-opt-in-on">
            <AlertTitle>Extended retention is switched on</AlertTitle>
            <AlertDescription>
              Evidence held past the included {retention.includedMonths} months
              bills at {formatUsdRate(retention.usdPerGbMonth)} per GB-month.
              This is the one Oxagen cost that compounds with time rather than
              with usage, so it keeps growing for as long as the evidence is
              held.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="success" data-testid="retention-opt-in-off">
            <AlertTitle>Nothing is accruing</AlertTitle>
            <AlertDescription>
              You have not opted into paying for retention beyond the included{" "}
              {retention.includedMonths} months, so no retention charge can
              accrue on this organisation. If you turn it on, evidence held past
              that window bills at {formatUsdRate(retention.usdPerGbMonth)} per
              GB-month.
            </AlertDescription>
          </Alert>
        )}

        {retention.storedGbMeasured ? null : (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {NOT_MEASURED_LABEL}
            </span>{" "}
            is not the same as zero. No job has counted this
            organisation&rsquo;s evidence volume yet, so this page reports the
            absence rather than claiming you are storing nothing.
          </p>
        )}

        {retention.effectiveRetentionDays === null ? (
          <p className="text-xs text-muted-foreground">
            No retention policy is pinned on any of your workspaces. That means
            none has been declared — not that evidence is kept forever.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
