// The Cost tab (pages/run.md, Model fit and Cost; the mockup's `pRun`,
// `t==="cost"`): Model fit first, then the six instruments, Spend by area,
// Tool calls, the waterfall, and Spend by token class beside Prompt
// composition.
//
// Every figure is read from `props.metrics`, the one derivation the stat row
// and the header read too (`metrics.ts`), and summed once by
// `cost-figures.ts`, so no two panels can disagree: the Tokens instrument,
// the total row of Spend by token class and the stat row's Tokens are one
// number, and the waterfall's total row is the Shape of the run instrument's.
// Every money figure carries its basis (INV-10). A figure the record does not
// carry (the prompt's measured parts, speculative prefetch, finding pins, the
// agent's median run) is drawn where the mockup draws it and reads "not
// recorded".
//
// The tab makes no read of its own: the page read the rollup, the whole-run
// transcript and the price book for the header and the stat row, and the
// metrics hold what this tab draws from them. `run.tsx` calls `CostTab` as a
// function, so it calls no hook itself; the sections it returns do.
import { useTranslations } from "next-intl";
import type { RunTabProps } from "./tab-props";
import { classPrices, ledgerOf } from "./cost-figures";
import { Instruments } from "./instruments";
import { ModelFitPanel } from "./model-fit";
import { SpendByArea } from "./spend-by-area";
import { TokenClassesAndComposition } from "./token-classes";
import { ToolCalls } from "./tool-calls";
import { WaterfallPanel } from "./waterfall";

/** The line that says an open run's figures are an estimate (#3980). */
function CostEstimate() {
  const t = useTranslations("run.cost");
  return (
    <p
      data-testid="cost-estimate"
      className="max-w-prose text-sm text-muted-foreground"
    >
      {t("estimate")}
    </p>
  );
}

/** The Cost tab over the page's bundle. */
export function CostTab({
  run,
  metrics,
  agent,
  cost,
  everything,
}: RunTabProps) {
  const ledger = ledgerOf(metrics.turns ?? []);
  const prices = classPrices(metrics.priced, metrics.tokens);
  const retries = cost.ok ? (cost.value.rollup?.retries ?? null) : null;
  // A rollup built while the run was open covers the calls recorded so far
  // (#3980), and the tab says so above its figures.
  const estimate = cost.ok && cost.value.rollup?.isEstimate === true;
  return (
    <div data-testid="cost-tab" className="flex flex-col gap-3.5">
      {estimate ? <CostEstimate /> : null}
      <ModelFitPanel run={run} metrics={metrics} agent={agent} />
      <Instruments
        run={run}
        metrics={metrics}
        ledger={ledger}
        prices={prices}
        retries={retries}
      />
      <SpendByArea metrics={metrics} prices={prices} />
      <ToolCalls metrics={metrics} />
      <WaterfallPanel
        metrics={metrics}
        ledger={ledger}
        transcript={everything}
      />
      <TokenClassesAndComposition
        metrics={metrics}
        prices={prices}
        cost={cost}
      />
    </div>
  );
}
