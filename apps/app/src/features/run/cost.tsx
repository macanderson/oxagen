// The Cost tab (pages/run.md, Model fit and Cost; the mockup's `pRun`,
// `t==="cost"`): Model fit first, then the six instruments, Spend by area,
// Tool calls, the waterfall, and Spend by token class beside Prompt
// composition.
//
// Every figure but the per-turn ledger is read from `props.metrics`, the one
// derivation the stat row and the header read too (`metrics.ts`), and summed
// once by `cost-figures.ts`, so no two panels can disagree: the Tokens instrument,
// the total row of Spend by token class and the stat row's Tokens are one
// number, and the waterfall's total row is the Shape of the run instrument's.
// Every money figure carries its basis (INV-10). A figure the record does not
// carry (the prompt's measured parts, speculative prefetch) is drawn where the
// mockup draws it and reads "not recorded".
//
// The tab makes reads of its own, in parallel. `get_run_turns` is the run's
// per-turn ledger over every frame it recorded, counted where the frames are
// stored. The waterfall, its table, and the Cost so far and Shape of the run
// instruments are drawn from it. It used to add the turns up from the
// whole-run transcript, read 200 entries at a time, which took 68 reads on a
// 250,000-frame run and stopped at the transcript's 10,000-frame fold (#4067).
// `list_findings` for the run is the open findings that cite it, which the
// waterfall pins to the turns they cite (#4001). With `?finding=` set, the tab
// also reads that finding's evidence and opens it over itself.
//
// Every other figure comes from the reads the page already made for the header
// and the stat row. The agent baseline and the graded steps ride
// `get_run_cost` (#3984). `run.tsx` calls `CostTab` as a function and awaits
// it, so it calls no hook itself; the sections it returns do.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunFindings, RunTurns } from "@/data/contracts/run";
import { type Read, readOk } from "@/data/read";
import { FindingEvidence } from "@/features/spend";
import { routes } from "@/shared/safe-path";
import type { RunTabProps } from "./tab-props";
import { classPrices, ledgerOf } from "./cost-figures";
import { Instruments } from "./instruments";
import { turnFigures } from "./metrics";
import { ModelFitPanel } from "./model-fit";
import { SpendByArea } from "./spend-by-area";
import { TokenClassesAndComposition } from "./token-classes";
import { ToolCalls } from "./tool-calls";
import { type TurnLedger, WaterfallPanel } from "./waterfall";

/** A finding's public id; anything else in `?finding=` opens nothing. */
const FINDING_ID = /^fnd_[0-9a-z]+$/;

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

/** The Cost tab over the page's bundle and its own reads. */
export async function CostTab(props: RunTabProps): Promise<ReactNode> {
  const { ctx, source, run, place, view } = props;
  const open =
    view.finding !== undefined &&
    view.finding !== null &&
    FINDING_ID.test(view.finding)
      ? view.finding
      : null;
  const [turns, findings, evidence] = await Promise.all([
    source.runs.turns(ctx, run.id),
    source.runs.findings(ctx, run.id),
    open === null ? null : source.spend.findingEvidence(ctx, open),
  ]);
  return (
    <>
      <CostSections {...props} turns={turns} findings={findings} />
      {evidence === null ? null : (
        <FindingEvidence
          evidence={evidence}
          at={{ org: place.org, ws: place.ws }}
          close={routes.run(place.org, place.ws, place.runId, {
            tab: "cost",
          })}
        />
      )}
    </>
  );
}

function CostSections({
  run,
  metrics,
  agent,
  cost,
  place,
  turns,
  findings,
}: RunTabProps & { turns: Read<RunTurns>; findings: Read<RunFindings> }) {
  const summed: Read<TurnLedger> = turns.ok
    ? readOk({
        ledger: ledgerOf(turnFigures(turns.value.turns)),
        complete: turns.value.complete,
        chains: turns.value.chains,
      })
    : turns;
  const ledger = summed.ok ? summed.value.ledger : null;
  const prices = classPrices(metrics.priced, metrics.tokens);
  const rollup = cost.ok ? cost.value.rollup : null;
  const baseline = cost.ok ? (cost.value.baseline ?? null) : null;
  const retries = rollup?.retries ?? null;
  // A rollup built while the run was open covers the calls recorded so far
  // (#3980), and the tab says so above its figures. The rule is the stat
  // row's (`costIsEstimate`), so an open run whose row still reads final is
  // an estimate on both.
  const estimate = rollup !== null && metrics.costIsEstimate;
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
        steps={
          rollup === null
            ? null
            : {
                advanced: rollup.advancedSteps,
                unproductive: rollup.unproductiveSteps,
                causes: rollup.unproductiveCauses,
              }
        }
        baseline={baseline}
      />
      <SpendByArea
        metrics={metrics}
        prices={prices}
        byTool={rollup?.byTool ?? null}
      />
      <ToolCalls metrics={metrics} />
      <WaterfallPanel
        metrics={metrics}
        turns={summed}
        findings={findings}
        place={place}
      />
      <TokenClassesAndComposition
        metrics={metrics}
        prices={prices}
        cost={cost}
      />
    </div>
  );
}
