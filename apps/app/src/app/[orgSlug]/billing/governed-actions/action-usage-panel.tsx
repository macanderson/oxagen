/**
 * action-usage-panel.tsx — "why is my bill this number", rendered.
 *
 * Reads `get_action_usage`. Three things here are load-bearing and must not be
 * quietly tidied away by a future redesign:
 *
 *   1. `meterMode: "shadow"` gets the most prominent element on the page. A
 *      usage readout that looks like a bill while nothing is being billed is a
 *      lie in the opposite direction from an unexplained charge, and it is the
 *      easier one to ship by accident.
 *   2. `bandTrueUpCredits` is money owed BACK to the customer. It is shown
 *      whenever it is non-zero, with a sentence saying what it is — the
 *      discrepancy is worth more to a customer than the amount.
 *   3. `modelSpend.chargedCredits` is always zero and the row is always
 *      rendered. The zero is the message: BYOK tokens were already paid for by
 *      the customer's own key, and omitting the line would lose that promise.
 */

import { Panel } from "@/components/ui/panel";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BillingActionUsageOutput } from "@oxagen/oxagen/contracts/billing.action_usage";
import {
  allowanceConsumedFraction,
  formatActions,
  formatCreditsUsd,
  formatPeriod,
  formatUsdFromMicros,
  formatUsdRate,
} from "./action-meter-format";

export interface ActionUsagePanelProps {
  usage: BillingActionUsageOutput;
}

/**
 * The shadow-mode banner.
 *
 * Exported separately so the page can hoist it above every panel — it changes
 * the meaning of every figure below it, so it must be read first.
 */
export function MeterModeBanner({
  mode,
}: {
  mode: BillingActionUsageOutput["meterMode"];
}) {
  if (mode !== "shadow") return null;
  return (
    <Alert variant="info" data-testid="meter-mode-shadow">
      <AlertTitle>Shadow mode — counting, not charging</AlertTitle>
      <AlertDescription>
        The governed-action meter is recording your usage but raising no
        charges. Every figure on this page is what you <em>would</em> be billed
        once charging is switched on. Nothing here is on an invoice today.
      </AlertDescription>
    </Alert>
  );
}

export function ActionUsagePanel({ usage }: ActionUsagePanelProps) {
  const isShadow = usage.meterMode === "shadow";
  const consumed = allowanceConsumedFraction(
    usage.actionsUsed,
    usage.actionsIncluded,
  );
  const hasActivity = usage.actionsUsed > 0;

  return (
    <Panel
      title="This entitlement year"
      eyebrow="Governed actions"
      actions={
        <Badge variant={isShadow ? "info-soft" : "success-soft"} dot>
          {isShadow ? "Shadow — not charging" : "Charging"}
        </Badge>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-xs text-muted-foreground">
          {formatPeriod(usage.period)} · priced in band{" "}
          <span className="font-medium text-foreground">{usage.band.id}</span>{" "}
          at {formatUsdRate(usage.band.usdPer1000)} per 1,000 actions
        </p>

        {hasActivity ? null : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="usage-empty-state"
          >
            No governed actions have been recorded this year yet. A governed
            action is one top-level capability invocation that passed its gates
            and completed — run an agent, call the API, or use an MCP tool and
            the count starts here.
          </p>
        )}

        <StatGroup columns={4}>
          <Stat
            label="Actions used"
            value={formatActions(usage.actionsUsed)}
            hint="this entitlement year"
          />
          <Stat
            label="Included in plan"
            value={formatActions(usage.actionsIncluded)}
            hint={
              consumed === null
                ? "no allowance on this plan"
                : `${Math.round(consumed * 100)}% consumed`
            }
          />
          <Stat
            label="Covered by allowance"
            value={formatActions(usage.actionsWithinAllowance)}
            hint="free — inside the plan"
          />
          <Stat
            label="Charged as overage"
            value={formatActions(usage.actionsCharged)}
            hint={`${formatActions(usage.actionsRemaining)} left before overage`}
          />
        </StatGroup>

        {usage.bandTrueUpCredits > 0 ? (
          <Alert variant="success" data-testid="band-true-up">
            <AlertTitle>
              True-up owed to you: {formatCreditsUsd(usage.bandTrueUpCredits)}
            </AlertTitle>
            <AlertDescription>
              Your actions were charged as they happened, at whichever volume
              band your running total was in at the time. The published rule
              prices the whole year at the single band your year-end total lands
              in. You crossed a band boundary, so you paid{" "}
              {formatCreditsUsd(usage.creditsCharged)} where the year-end rule
              gives {formatCreditsUsd(usage.creditsAtFinalBand)}. The difference
              is credited back to you at reconciliation — it is shown here so
              you see it before the invoice, not after.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">
              Governed-action charges and model spend for the current
              entitlement year
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Line</TableHead>
                <TableHead scope="col">Amount</TableHead>
                <TableHead scope="col">What it means</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableHead scope="row" className="font-medium">
                  Governed actions charged
                </TableHead>
                <TableCell>{formatCreditsUsd(usage.creditsCharged)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {isShadow
                    ? "What the ledger would have debited. Shadow mode raises no charge."
                    : "Read back from the credit ledger — the figure charged, not a model of it."}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row" className="font-medium">
                  Same volume at your year-end band
                </TableHead>
                <TableCell>
                  {formatCreditsUsd(usage.creditsAtFinalBand)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  The published rule: the whole year&rsquo;s overage priced at
                  the one band your annual total lands in.
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row" className="font-medium">
                  Band true-up
                </TableHead>
                <TableCell>
                  {formatCreditsUsd(usage.bandTrueUpCredits)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Owed back to you. Zero when you have not crossed a band
                  boundary this year.
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row" className="font-medium">
                  Model tokens reported
                </TableHead>
                <TableCell>
                  {formatUsdFromMicros(usage.modelSpend.reportedCostMicros)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Provider token cost over the period, reported in full.
                </TableCell>
              </TableRow>
              <TableRow data-testid="model-tokens-zero-row">
                <TableHead scope="row" className="font-medium">
                  Model tokens charged
                </TableHead>
                <TableCell>
                  {formatCreditsUsd(usage.modelSpend.chargedCredits)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Zero, deliberately. Under BYOK your own provider key already
                  paid the vendor for those tokens; billing you again would be
                  charging twice for one call.
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row" className="font-medium">
                  Assistant tokens on the platform key
                </TableHead>
                <TableCell>
                  {formatCreditsUsd(usage.modelSpend.assistantTokenCredits)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  The one model-spend line that is billed back — tokens
                  Oxagen&rsquo;s own key paid for. Zero when you are on your own
                  key.
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        {usage.byCapability.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Where the activity went</h3>
            <p className="text-xs text-muted-foreground">
              Successful capability invocations for the period. This is an upper
              bound on billed actions, not a partition of them: a nested call
              leaves an audit row while only the top-level one is charged, and
              nothing recorded tells the two apart afterwards.
            </p>
            <div className="overflow-x-auto">
              <Table>
                <caption className="sr-only">
                  Capability invocations by capability name
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Capability</TableHead>
                    <TableHead scope="col">Invocations</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.byCapability.map((row) => (
                    <TableRow key={row.capability}>
                      <TableHead scope="row" className="font-normal">
                        {row.capability}
                      </TableHead>
                      <TableCell>{formatActions(row.actions)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
