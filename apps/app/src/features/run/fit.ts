// Whether the model and the effort setting were the right size for this run
// (pages/run.md, Model fit; ADR-201). Oxagen computes the reading from the
// record after the seal and stores it on the run, versioned `run-fit/v1`,
// with the figures it read and the seal it read. `get_run` answers it as
// `run.fit`. The page computes nothing: the rig strip's badges and the Cost
// tab's Model fit panel both draw `run.fit`, so they cannot disagree.
//
// The reading is generated, not the record. It argues for a change to the
// agent definition and changes nothing on its own, and a sealed run keeps the
// model it ran on. It names a capability class one rung up or down the
// vendor's own family, never a model id.
//
// The effort value itself is the record's (`run.effort`, with where it was
// read), which the rig and the effort card print from one helper here, so the
// two cannot disagree either.
import type { RunRow } from "@/data/contracts/runs";

/**
 * The stored reading, as `get_run` answers it.
 *
 * @internal Exported for the tests that build a reading.
 */
export type RunFit = NonNullable<RunRow["fit"]>;
export type FitRead = NonNullable<RunFit["read"]>;
export type ModelFit = NonNullable<RunFit["model"]>;

/**
 * The effort setting as the record holds it (#3891): the value and where it
 * was read, or why none was. The rig strip and the Cost tab's effort card
 * both read this, so the two cannot disagree.
 *
 * `request` is the setting a model request body carried, which Oxagen reads
 * where it proxied the call. `harness` is the harness's own report. With
 * neither, the reason is `not_sent` where Oxagen proxied the calls (the
 * gateway and contained tiers) and the request carried none, and
 * `not_proxied` elsewhere, where Oxagen never saw the request body.
 */
type RunEffort =
  | { seen: true; value: string; source: "request" | "harness" }
  | { seen: false; why: "not_proxied" | "not_sent" };

export function runEffort(run: RunRow): RunEffort {
  // A row from `list_runs` leaves the effort out; one from `get_run` answers
  // null when the record holds none.
  if (typeof run.effort === "string" && run.effort !== "")
    return {
      seen: true,
      value: run.effort,
      source: run.effortSource ?? "harness",
    };
  return {
    seen: false,
    why:
      run.enforcementTier === "gateway" || run.enforcementTier === "contained"
        ? "not_sent"
        : "not_proxied",
  };
}

/**
 * The reading the page draws, or null: a live run has none, since the
 * reading is of a seal, and neither has a run whose reading is not stored
 * yet or read an earlier seal (`get_run` answers null for both).
 */
export function fitOf(run: RunRow): RunFit | null {
  return run.status === "live" ? null : run.fit;
}

/** The effort verdict with a move in it: one rung down (over) or up (under). */
type EffortMove = { verdict: "over" | "under"; suggest: string };

/**
 * The effort verdict the page draws beside the record's own value, or null
 * when there is none to draw: no reading, an effort the record does not
 * hold, or a reading of a value other than the one the rig prints. So the
 * card never argues about a setting the rig does not show.
 */
export function effortVerdict(
  run: RunRow,
): { verdict: "fit" } | EffortMove | null {
  const fit = fitOf(run);
  const effort = runEffort(run);
  if (fit === null || !effort.seen || fit.effort.verdict === "unseen")
    return null;
  if (fit.effort.effort !== effort.value) return null;
  return fit.effort.verdict === "fit"
    ? { verdict: "fit" }
    : { verdict: fit.effort.verdict, suggest: fit.effort.suggest };
}
