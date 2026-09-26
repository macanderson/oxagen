// Whether the model and the effort setting were the right size for this run
// (pages/run.md, Model fit; the mockup's `runFit`). The rig strip's badges and
// the Cost tab's Model fit panel both read this, so they cannot disagree.
//
// The reading is keyed on what the run record varies: prompts, failed tool
// calls, turns and steps. It is never keyed on reasoning share, which is a
// fixed fraction of output per model family and so describes the model, not
// the run. It is generated, not the record: it argues for a change to the
// agent definition and changes nothing on its own, and a sealed run keeps
// the model it ran on.
//
// It names a capability class one rung up or down the vendor's own family,
// never a model id: which id serves a class is the agent definition's choice,
// made in the pull request the reading argues for.
import type { RunRow } from "@/data/contracts/runs";
import type { RunMetrics } from "./metrics";

/**
 * Each vendor family's capability classes, smallest first, as the run row's
 * `model.tier` names them (`packages/handlers/src/lib/model-facts.ts`). A
 * class absent here has no rung this reading will claim.
 */
const LADDERS: readonly (readonly string[])[] = [
  ["haiku", "sonnet", "opus"],
  ["nano", "mini"],
  ["flash-lite", "flash", "pro"],
];

/** A run this short, landed first try, is a small job for any model. */
const SMALL_TURNS = 3;
const SMALL_STEPS = 12;

export type FitRead = {
  prompts: number;
  turns: number;
  steps: number;
  failed: number;
};

export type ModelFit =
  | { verdict: "fit"; tier: string }
  | {
      verdict: "over" | "under";
      tier: string;
      /** The class one rung down (over) or up (under) the same family. */
      suggest: string;
    };

/**
 * Why the effort setting was not read. Oxagen reads it out of the model
 * request's body, which it holds only where it proxied the call (the gateway
 * and contained tiers). No contract carries it today at any tier, so every
 * run answers one of these two, and the page never prints a value.
 */
type EffortFit = { verdict: "unseen"; why: "not_proxied" | "not_sent" };

export type RunFit = {
  /** What the reading read; null when the record lacks a figure it is keyed on. */
  read: FitRead | null;
  /** Null when the read is null or the model's class sits on no known ladder. */
  model: ModelFit | null;
  effort: EffortFit;
};

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
export type RunEffort =
  | { seen: true; value: string; source: "request" | "harness" }
  | { seen: false; why: "not_proxied" | "not_sent" };

export function runEffort(run: RunRow): RunEffort {
  if (run.effort !== null && run.effort !== "")
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

function rungOf(tier: string | null) {
  if (tier === null) return null;
  for (const ladder of LADDERS) {
    const rank = ladder.indexOf(tier);
    if (rank !== -1) return { ladder, rank };
  }
  return null;
}

export function runFit(run: RunRow, metrics: RunMetrics): RunFit {
  const effort: EffortFit = {
    verdict: "unseen",
    why:
      run.enforcementTier === "gateway" || run.enforcementTier === "contained"
        ? "not_sent"
        : "not_proxied",
  };
  const turns = run.turns;
  const failed = metrics.toolCalls?.failed;
  if (
    metrics.prompts === null ||
    turns === null ||
    failed === undefined ||
    // A sealed run read past the transcript's cap holds floors, not counts.
    // A live run's read is everything recorded so far, which is what a
    // reading of a live run is about.
    (!metrics.whole && run.sealedAt !== null)
  )
    return { read: null, model: null, effort };
  const read: FitRead = {
    prompts: metrics.prompts.count,
    turns,
    steps: run.steps,
    failed,
  };
  const tier = run.model?.tier ?? null;
  const rung = rungOf(tier);
  if (tier === null || rung === null) return { read, model: null, effort };
  const redone = read.prompts > 1 || read.failed > 0;
  const small = read.turns <= SMALL_TURNS || read.steps <= SMALL_STEPS;
  const lower = rung.ladder[rung.rank - 1];
  const higher = rung.ladder[rung.rank + 1];
  if (!redone && small && lower !== undefined)
    return { read, model: { verdict: "over", tier, suggest: lower }, effort };
  if (redone && higher !== undefined)
    return { read, model: { verdict: "under", tier, suggest: higher }, effort };
  return { read, model: { verdict: "fit", tier }, effort };
}
