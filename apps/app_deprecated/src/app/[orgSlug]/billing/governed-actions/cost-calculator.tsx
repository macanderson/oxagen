"use client";
/**
 * cost-calculator.tsx — the run → action → price calculator
 * (`preview_action_cost`).
 *
 * ADR-052's Consequences section names a published calculator as part of
 * shipping the meter: "governed action" is precise and "run" is legible, and a
 * buyer who cannot convert their own volume into a price has been handed a rate
 * card they cannot use.
 *
 * The result panel leads with the assumptions the handler returns —
 * `actionsPerRun` and `actionsPerRunSource` — because a conversion whose ratio
 * is hidden is a quote a buyer cannot check. The ratio is rendered before the
 * price, not in a footnote under it.
 *
 * Inputs are native `<select>` / `<input>` with `<Label htmlFor>` bindings:
 * keyboard-complete, announced correctly, and settable by automation without a
 * React-controlled-value dance.
 */

import * as React from "react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type { BillingActionEstimateOutput } from "@oxagen/oxagen/contracts/billing.action_estimate";
import {
  previewActionCostAction,
  type PreviewActionCostInput,
} from "./actions";
import { EstimateResult } from "./estimate-result";
import { runClassLabel, tierLabel } from "./action-meter-format";

const SELECT_CLASS =
  "w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const RUN_CLASSES = [
  "qa_lookup",
  "standard_task",
  "multi_step",
  "long_running",
] as const;

const TIERS = ["free", "build", "scale", "enterprise"] as const;

type RunClass = (typeof RUN_CLASSES)[number];
type Tier = (typeof TIERS)[number];

export interface CostCalculatorProps {
  orgSlug: string;
  /** The caller's own tier — the sensible default to quote against. */
  defaultTier?: Tier;
}

type State =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "error"; message: string }
  | { status: "done"; estimate: BillingActionEstimateOutput };

export function CostCalculator({
  orgSlug,
  defaultTier = "scale",
}: CostCalculatorProps) {
  const [runsPerYear, setRunsPerYear] = React.useState("100000");
  const [runClass, setRunClass] = React.useState<RunClass>("standard_task");
  const [actionsPerRun, setActionsPerRun] = React.useState("");
  const [tier, setTier] = React.useState<Tier>(defaultTier);
  const [state, setState] = React.useState<State>({ status: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const runs = Number(runsPerYear);
    if (!Number.isFinite(runs) || runs < 1) {
      setState({
        status: "error",
        message: "Enter a whole number of runs per year — 1 or more.",
      });
      return;
    }
    const overrideRaw = actionsPerRun.trim();
    const override = overrideRaw === "" ? undefined : Number(overrideRaw);
    if (
      override !== undefined &&
      (!Number.isFinite(override) || override <= 0)
    ) {
      setState({
        status: "error",
        message:
          "The actions-per-run override must be a positive number, or left blank to use the published ratio.",
      });
      return;
    }

    setState({ status: "busy" });
    const input: PreviewActionCostInput = {
      orgSlug,
      runsPerYear: Math.floor(runs),
      runClass,
      tier,
      ...(override === undefined ? {} : { actionsPerRun: override }),
    };
    const result = await previewActionCostAction(input);
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "done", estimate: result.data });
  }

  const busy = state.status === "busy";

  return (
    <Panel title="Estimate your cost" eyebrow="Runs → actions → price">
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Convert the run volume you plan on into governed actions and a price.
          The result shows the actions-per-run ratio it used and where that
          ratio came from, so you can check the arithmetic rather than take it.
        </p>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
          aria-label="Governed action cost estimate"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-runs-per-year">Runs per year</Label>
              <Input
                id="calc-runs-per-year"
                name="runsPerYear"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={runsPerYear}
                onChange={(e) => setRunsPerYear(e.target.value)}
                disabled={busy}
                aria-describedby="calc-runs-per-year-hint"
              />
              <p
                id="calc-runs-per-year-hint"
                className="text-xs text-muted-foreground"
              >
                Agent runs you expect in an entitlement year.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-run-class">Run class</Label>
              <select
                id="calc-run-class"
                name="runClass"
                className={SELECT_CLASS}
                value={runClass}
                onChange={(e) => setRunClass(e.target.value as RunClass)}
                disabled={busy}
                aria-describedby="calc-run-class-hint"
              >
                {RUN_CLASSES.map((value) => (
                  <option key={value} value={value}>
                    {runClassLabel(value)}
                  </option>
                ))}
              </select>
              <p
                id="calc-run-class-hint"
                className="text-xs text-muted-foreground"
              >
                Sets the published actions-per-run ratio.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-actions-per-run">
                Actions per run (optional)
              </Label>
              <Input
                id="calc-actions-per-run"
                name="actionsPerRun"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                placeholder="Use the published ratio"
                value={actionsPerRun}
                onChange={(e) => setActionsPerRun(e.target.value)}
                disabled={busy}
                aria-describedby="calc-actions-per-run-hint"
              />
              <p
                id="calc-actions-per-run-hint"
                className="text-xs text-muted-foreground"
              >
                If you have measured your own ratio, it wins over the run class.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-tier">Tier</Label>
              <select
                id="calc-tier"
                name="tier"
                className={SELECT_CLASS}
                value={tier}
                onChange={(e) => setTier(e.target.value as Tier)}
                disabled={busy}
                aria-describedby="calc-tier-hint"
              >
                {TIERS.map((value) => (
                  <option key={value} value={value}>
                    {tierLabel(value)}
                  </option>
                ))}
              </select>
              <p id="calc-tier-hint" className="text-xs text-muted-foreground">
                Decides the included allowance the quote subtracts.
              </p>
            </div>
          </div>

          <div>
            <Button type="submit" disabled={busy} data-testid="calc-submit">
              {busy ? "Calculating…" : "Calculate"}
            </Button>
          </div>
        </form>

        <div aria-live="polite" aria-atomic="true">
          {state.status === "idle" ? (
            <p className="text-xs text-muted-foreground">
              No estimate yet — set your volume and calculate.
            </p>
          ) : null}

          {state.status === "busy" ? (
            <p className="text-xs text-muted-foreground">
              Calculating the estimate…
            </p>
          ) : null}

          {state.status === "error" ? (
            <Alert variant="error" data-testid="calc-error">
              <AlertTitle>Couldn&rsquo;t calculate that estimate</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}

          {state.status === "done" ? (
            <EstimateResult estimate={state.estimate} />
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
