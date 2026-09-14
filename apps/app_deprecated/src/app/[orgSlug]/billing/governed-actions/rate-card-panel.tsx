/**
 * rate-card-panel.tsx — the published price, rendered as a table a buyer can
 * check their statement against.
 *
 * Reads `get_rate_card`. Two rules survive here from the contract:
 *
 *   - A tier whose `includedActionsAnnual` is null is NEGOTIATED, not
 *     unlimited. It renders as words (see `formatIncludedAllowance`), never as
 *     ∞ and never as an empty cell.
 *   - `modelTokens.usdPerToken` is zero and the row is always rendered with its
 *     explanation. An omitted row would read as "we haven't said", where the
 *     zero is an explicit promise.
 *
 * Real `<table>` semantics throughout: a price table read by a screen reader
 * has to keep its row and column headers, and the caller's own tier is marked
 * with text as well as a tint so the highlight is not colour-only.
 */

import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BillingActionRateCardOutput } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import {
  formatActions,
  formatBandRange,
  formatIncludedAllowance,
  formatUsdRate,
  tierLabel,
} from "./action-meter-format";

export interface RateCardPanelProps {
  rateCard: BillingActionRateCardOutput;
}

export function RateCardPanel({ rateCard }: RateCardPanelProps) {
  return (
    <Panel
      title="Rate card"
      eyebrow="Published price"
      actions={
        <Badge variant="muted">Your tier: {tierLabel(rateCard.yourTier)}</Badge>
      }
    >
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">{rateCard.summary}</p>
        <p className="text-xs text-muted-foreground">
          Your plan includes{" "}
          <span className="font-medium text-foreground">
            {formatActions(rateCard.yourIncludedActionsAnnual)} governed actions
          </span>{" "}
          per entitlement year. The same table applies to every organisation on
          your tier.
        </p>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Volume bands</h3>
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Price per 1,000 governed actions by annual volume band
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Band</TableHead>
                  <TableHead scope="col">Annual actions</TableHead>
                  <TableHead scope="col">Per 1,000 actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rateCard.bands.map((band) => (
                  <TableRow key={band.id}>
                    <TableHead scope="row" className="font-medium">
                      {band.id}
                    </TableHead>
                    <TableCell>{formatBandRange(band)}</TableCell>
                    <TableCell>{formatUsdRate(band.usdPer1000)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Included per tier</h3>
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Governed actions and evidence retention included on each plan
                tier
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Tier</TableHead>
                  <TableHead scope="col">Included actions / year</TableHead>
                  <TableHead scope="col">Evidence retention</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rateCard.tiers.map((tier) => {
                  const isYours = tier.tier === rateCard.yourTier;
                  return (
                    <TableRow
                      key={tier.tier}
                      className={isYours ? "bg-muted/40" : undefined}
                      data-testid={`rate-card-tier-${tier.tier}`}
                    >
                      <TableHead scope="row" className="font-medium">
                        {tierLabel(tier.tier)}
                        {/* Text, not just the tint — colour alone is never the
                            carrier of meaning. */}
                        {isYours ? (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            (your tier)
                          </span>
                        ) : null}
                      </TableHead>
                      <TableCell>
                        {formatIncludedAllowance(tier.includedActionsAnnual)}
                      </TableCell>
                      <TableCell>
                        {tier.retentionMonths}{" "}
                        {tier.retentionMonths === 1 ? "month" : "months"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            An included allowance shown as &ldquo;
            {formatIncludedAllowance(null)}&rdquo; is set in your agreement. It
            is not an unlimited allowance, and this page will not invent the
            number that was negotiated.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">The other two lines</h3>
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Evidence retention price and the model-token rate
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Line</TableHead>
                  <TableHead scope="col">Price</TableHead>
                  <TableHead scope="col">Terms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableHead scope="row" className="font-medium">
                    Evidence retention
                  </TableHead>
                  <TableCell>
                    {formatUsdRate(rateCard.retention.usdPerGbMonth)} per
                    GB-month
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {rateCard.retention.includedMonths} months included.
                    {rateCard.retention.optIn
                      ? " Anything beyond that is opt-in — it never starts accruing on its own."
                      : null}
                  </TableCell>
                </TableRow>
                {/* Always rendered. The zero IS the message. */}
                <TableRow data-testid="rate-card-model-tokens">
                  <TableHead scope="row" className="font-medium">
                    Model tokens
                  </TableHead>
                  <TableCell>
                    {formatUsdRate(rateCard.modelTokens.usdPerToken)} per token
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {rateCard.modelTokens.explanation}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </Panel>
  );
}
