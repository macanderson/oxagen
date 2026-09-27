/**
 * Unpaged results (detector 5, context carry). A tool result stays in the
 * context until the context sheds it, and every later request on the call's
 * chain re-reads it. For a result over `CARRY_RESULT_TOKENS`, the finding
 * prices each of those re-reads at the run's read price, against nothing: a
 * paged result, an earlier compaction, or a subagent would each keep most of
 * it out. It prices a part of a request, so it claims no frame (ADR-208,
 * counting rule 2). A call a repeat finding can cite is left to that finding,
 * whether or not its request counted.
 *
 * Each re-read is one cited item, so `evidence.calls` counts re-reads, and a
 * result cites its call's frame once. The count needs the run's model-call
 * frames on the call's own chain. Where the store read none, the count is
 * unknown, and a result over `UNPAGED_RESULT_TOKENS` is priced as the finding
 * first shipped: one read at the run's input price, against a page of
 * `PAGE_TOKENS`.
 *
 * No compaction record reaches this pass, so {@link carriesOf} ends the carry
 * where the frames show the context shrank by at least the result's size.
 */
import {
  priceInputTokens,
  runInputPrice,
  type InputPrice,
  type RunTotalsRecord,
} from "../cost-rollup";
import type { ViewCall } from "./requests";
import {
  PAGE_TOKENS,
  plural,
  resultMeasure,
  timeOf,
  UNPAGED_RESULT_TOKENS,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type Measure,
  type PricedRequestFrame,
} from "./shared";

/** A result above this many tokens is priced for every request that re-reads it. */
export const CARRY_RESULT_TOKENS = 5_000;

/** Whether a repeat finding can cite the call: a shell repeat, or a read-only repeat on a run that names an agent or operator. */
function citableRepeat(c: ViewCall, run: RunTotalsRecord): boolean {
  return (
    c.repeat === "shell" ||
    (c.repeat === "read" && (run.agentKey !== null || run.operatorKey !== null))
  );
}

/**
 * What a run paid to re-read one token already in its context: its cache
 * reads' cost over their tokens. A run that read no cache re-sent every
 * token, so its uncached input price is the read price. Null when nothing
 * priced the reads, and for an estimated or unpriced run, as
 * `runInputPrice` rules.
 */
export function runReadPrice(run: RunTotalsRecord): InputPrice | null {
  if (run.costBasis === null || run.costBasis === "estimated") return null;
  let micros = 0n;
  let tokens = 0n;
  for (const m of run.breakdown.models) {
    micros += m.costByClass.cache_read;
    tokens += BigInt(m.tokens.cache_read);
  }
  if (tokens === 0n) return runInputPrice(run);
  return micros === 0n ? null : { micros, tokens };
}

/**
 * The requests that re-read a result of `resultTokens` made at `at`: the
 * frames after it on its chain, up to the first frame whose tokens fall at
 * least `resultTokens` below the frame before it. `chain` is in time order.
 *
 * With no compaction, a chain's context only grows from one request to the
 * next, so a drop that large means the context shed at least the result's own
 * size, and the result is taken to be gone. A drop from clearing some other
 * result ends the carry early, so the count errs low.
 */
export function carriesOf(
  chain: readonly PricedRequestFrame[],
  at: number,
  resultTokens: number,
): PricedRequestFrame[] {
  const out: PricedRequestFrame[] = [];
  let before: PricedRequestFrame | null = null;
  for (const f of chain) {
    if (timeOf(f) <= at) {
      before = f;
      continue;
    }
    if (before !== null && before.tokens - f.tokens >= resultTokens) break;
    out.push(f);
    before = f;
  }
  return out;
}

/**
 * A run's frames by chain, each in time order: "" for the run's own chain,
 * which also takes a frame that names no chain. Null when the store read no
 * frames for the run.
 */
function chainsOf(
  frames: readonly PricedRequestFrame[] | undefined,
): Map<string, PricedRequestFrame[]> | null {
  if (frames === undefined) return null;
  const out = new Map<string, PricedRequestFrame[]>();
  for (const f of frames) {
    const key = f.sessionUuid ?? "";
    const list = out.get(key) ?? [];
    list.push(f);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => timeOf(a) - timeOf(b));
  return out;
}

/** One re-read of a result at the run's read price, against nothing. */
function carryMeasure(price: InputPrice | null, tokens: number): Measure {
  return {
    measuredTokens: tokens,
    counterfactualTokens: 0,
    micros:
      price === null
        ? null
        : { measured: priceInputTokens(price, tokens), counterfactual: 0n },
  };
}

function detect(input: DetectInput, ctx: DetectContext): void {
  for (const view of ctx.views) {
    const chains = chainsOf(input.frames?.get(view.run.runId));
    const readPrice = runReadPrice(view.run);
    for (const c of view.calls) {
      if (ctx.taken.has(c.call) || citableRepeat(c, view.run)) continue;
      const tokens = c.call.resultTokens;
      if (tokens === null || tokens <= CARRY_RESULT_TOKENS) continue;
      const key: FindingKey = {
        kind: "unpaged_results",
        level: "tool",
        subject: c.call.tool,
      };
      if (!ctx.groups.admits(key, view.run)) continue;
      const chain = chains?.get(c.call.sessionUuid ?? "");
      if (chain === undefined) {
        if (tokens <= UNPAGED_RESULT_TOKENS) continue;
        ctx.groups.add(
          key,
          input.toolWindowStart,
          view.run,
          resultMeasure(view.run, tokens, () => PAGE_TOKENS),
          [c.frame],
        );
        continue;
      }
      const carries = carriesOf(chain, timeOf(c.call), tokens);
      for (let i = 0; i < carries.length; i += 1)
        ctx.groups.add(
          key,
          input.toolWindowStart,
          view.run,
          carryMeasure(readPrice, tokens),
          i === 0 ? [c.frame] : [],
        );
    }
  }
}

export const unpagedResults: Detector = {
  kinds: ["unpaged_results"],
  counting: null,
  detect,
  prose: (group, evidence) => {
    let results = 0;
    for (const cited of Object.values(evidence.frames ?? {}))
      results += cited.total;
    // The request right after a call is the first to read its result, so
    // the prose says "read": a result priced without frames counts that one.
    return {
      why: `${group.subject} returned ${plural(results, "result", "results")} over ${CARRY_RESULT_TOKENS.toLocaleString("en-US")} tokens on ${plural(group.runs.size, "run", "runs")}. Later requests read ${results === 1 ? "it" : "them"} ${plural(evidence.calls, "time", "times")}.`,
      fix: `Page ${group.subject}'s results at ${PAGE_TOKENS.toLocaleString("en-US")} tokens and fetch the rest on demand. A step that needs a large result once can run in a subagent, so the result stays out of the run's own context.`,
    };
  },
};
