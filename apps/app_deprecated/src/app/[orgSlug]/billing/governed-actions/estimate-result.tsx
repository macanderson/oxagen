/**
 * estimate-result.tsx — the calculator's answer, assumptions first.
 *
 * Split out of `cost-calculator.tsx` deliberately: this half is pure
 * presentation over a fixed handler payload, so keeping it clear of the
 * `"use server"` module the form calls lets the assumption-rendering rule be
 * unit-tested without standing up auth or the kernel.
 *
 * The rule it holds: `assumptions.actionsPerRun` and
 * `actionsPerRunSource` are rendered ABOVE the price, not in a footnote under
 * it. `preview_action_cost` exists because a conversion whose ratio is hidden
 * is a quote a buyer cannot check.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BillingActionEstimateOutput } from "@oxagen/oxagen/contracts/billing.action_estimate";
import {
  actionsPerRunSourceLabel,
  formatActions,
  formatIncludedAllowance,
  formatUsd,
  formatUsdRate,
  runClassLabel,
  tierLabel,
} from "./action-meter-format";

export function EstimateResult({
  estimate,
}: {
  estimate: BillingActionEstimateOutput;
}) {
  const { assumptions } = estimate;
  return (
    <div className="flex flex-col gap-4" data-testid="calc-result">
      <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
        <h3 className="text-sm font-semibold">Assumptions used</h3>
        <p className="mt-1 text-sm" data-testid="calc-assumptions">
          {formatActions(assumptions.runsPerYear)} runs × {""}
          <span className="font-medium">
            {assumptions.actionsPerRun.toLocaleString("en-US")} actions per run
          </span>{" "}
          — from {actionsPerRunSourceLabel(assumptions.actionsPerRunSource)} (
          {runClassLabel(assumptions.runClass)}), priced on the{" "}
          {tierLabel(assumptions.tier)} tier.
        </p>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <caption className="sr-only">
            Governed-action cost estimate for the projected run volume
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Line</TableHead>
              <TableHead scope="col">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableHead scope="row" className="font-medium">
                Governed actions per year
              </TableHead>
              <TableCell>{formatActions(estimate.actionsPerYear)}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row" className="font-medium">
                Included by the tier
              </TableHead>
              <TableCell data-testid="calc-included">
                {formatIncludedAllowance(estimate.includedActionsAnnual)}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row" className="font-medium">
                Actions past the allowance
              </TableHead>
              <TableCell>{formatActions(estimate.overageActions)}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row" className="font-medium">
                Band
              </TableHead>
              <TableCell>
                {estimate.band.id} · {formatUsdRate(estimate.band.usdPer1000)}{" "}
                per 1,000
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead scope="row" className="font-medium">
                Estimated overage
              </TableHead>
              <TableCell className="font-semibold">
                {formatUsd(estimate.overageUsd)} / year
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {estimate.includedActionsAnnual === null ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="calc-negotiated-note"
        >
          This tier&rsquo;s included allowance is negotiated per contract, so
          the quote prices your whole projected volume as overage. That is the
          upper bound of what you could owe — your agreement&rsquo;s allowance
          only brings it down.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">{estimate.excludes}</p>
    </div>
  );
}
