/**
 * Unpaged results (detector 5, context carry). A tool result stays in the
 * context until the context sheds it, and every later request on the call's
 * chain re-reads it. For a result over `CARRY_RESULT_TOKENS`, the finding
 * prices each of those re-reads at the read price of the request that made
 * it, against a page of `PAGE_TOKENS` at the same price: the fix pages the
 * result, and the page stays in the context. It prices a part of a request,
 * so it claims no frame (ADR-208, counting rule 2). A call a repeat finding
 * can cite is left to that finding, whether or not its request counted.
 *
 * Each re-read is one cited item, so `evidence.calls` counts re-reads, and a
 * result cites its call's frame once. The count needs the run's model-call
 * frames on the call's own chain. Where the store read none, the count is
 * unknown, and a result over `UNPAGED_RESULT_TOKENS` is priced as the finding
 * first shipped: one read at the run's input price, against a page of
 * `PAGE_TOKENS`.
 *
 * {@link carriesOf} ends the carry at the chain's first compaction after the
 * call, or earlier where the frames show the input context shrank by at least
 * the result's size.
 */
import {
  priceInputTokens,
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
  type RunCompaction,
} from "./shared";

/** A result above this many tokens is priced for every request that re-reads it. */
export const CARRY_RESULT_TOKENS = 5_000;

/** A price book entry is in micro-units per million tokens. */
const MILLION = 1_000_000n;

/** Whether a repeat finding can cite the call: a shell repeat, or a read-only repeat on a run that names an agent or operator. */
function citableRepeat(c: ViewCall, run: RunTotalsRecord): boolean {
  return (
    c.repeat === "shell" ||
    (c.repeat === "read" && (run.agentKey !== null || run.operatorKey !== null))
  );
}

/**
 * Whether the rollup left any model call of the run unpriced. Its per-class
 * tokens then count calls its per-class cost leaves out, so a price taken as
 * one over the other reads low (#4544).
 */
function partlyPriced(run: RunTotalsRecord): boolean {
  return run.breakdown.models.some((m) => m.hasUnpriced);
}

/**
 * What one request paid to re-read a token already in its context, from the
 * book's entry at the request's own instant (#4544). A request that read the
 * cache is priced at its cache read rate. A request that read none re-sent
 * every token, so its uncached input rate is the read price. Either rate is
 * the lowest any input token of that request paid, so the saving never reads
 * high.
 *
 * Null when the frame carries no class prices, when the book has no entry for
 * the class, or when the entry is not in the run's currency. A request that
 * read the cache is never priced at its uncached rate, which would read high.
 */
export function frameReadPrice(
  frame: PricedRequestFrame,
  currency: string,
): InputPrice | null {
  if (frame.classTokens === undefined || frame.classPrices === undefined)
    return null;
  const entry =
    frame.classTokens.cache_read > 0
      ? frame.classPrices.cache_read
      : frame.classPrices.input_uncached;
  if (entry === null || entry.currency !== currency) return null;
  return { micros: entry.microsPerMillion, tokens: MILLION };
}

/**
 * The tokens a request sent as its context: uncached input, cache reads, and
 * cache writes. Output and reasoning tokens are left out, since they do not
 * carry into the next request. Null when the frame carries no class tokens.
 */
export function inputContextOf(frame: PricedRequestFrame): number | null {
  const t = frame.classTokens;
  if (t === undefined) return null;
  return t.input_uncached + t.cache_read + t.cache_write_5m + t.cache_write_1h;
}

/**
 * The requests that re-read a result of `resultTokens` made at `at`: the
 * frames after it on its chain, up to the chain's first compaction after the
 * call, and up to the first frame whose input context falls at least
 * `resultTokens` below the frame before it. `chain` and `compactions` are the
 * chain's own, and `chain` is in time order.
 *
 * A frame at the compaction's own instant is taken to come after it. Between
 * compactions a chain's input context only grows, so a drop that large means
 * the context shed at least the result's size: a compaction the store has no
 * record of, or a cleared result. Clearing some other result ends the carry
 * early. The drop compares input context alone (#4544): a request's output
 * does not carry, so a fall in its total tokens says nothing about its
 * context. A frame with no class tokens has no input context to compare, so
 * it never ends the carry.
 */
export function carriesOf(
  chain: readonly PricedRequestFrame[],
  at: number,
  resultTokens: number,
  compactions: readonly RunCompaction[] = [],
): PricedRequestFrame[] {
  let end = Number.POSITIVE_INFINITY;
  for (const c of compactions) {
    const t = timeOf(c);
    if (t > at && t < end) end = t;
  }
  const out: PricedRequestFrame[] = [];
  let before: PricedRequestFrame | null = null;
  for (const f of chain) {
    const t = timeOf(f);
    if (t <= at) {
      before = f;
      continue;
    }
    if (t >= end) break;
    const was = before === null ? null : inputContextOf(before);
    const now = inputContextOf(f);
    if (was !== null && now !== null && was - now >= resultTokens) break;
    out.push(f);
    before = f;
  }
  return out;
}

/**
 * A run's compactions by chain, keyed as {@link chainsOf} keys frames: "" for
 * the run's own chain.
 */
function compactionsByChain(
  list: readonly RunCompaction[] | undefined,
): Map<string, RunCompaction[]> {
  const out = new Map<string, RunCompaction[]>();
  for (const c of list ?? []) {
    const key = c.sessionUuid ?? "";
    const chain = out.get(key) ?? [];
    chain.push(c);
    out.set(key, chain);
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

/**
 * One re-read of a result at the carrying request's read price, against a
 * re-read of one page at that price. `CARRY_RESULT_TOKENS` is above
 * `PAGE_TOKENS`, so every carry saves the tokens past the page. The measure
 * takes the request's own basis, so an unpriced request's carry is cited and
 * not covered.
 */
function carryMeasure(
  frame: PricedRequestFrame,
  currency: string,
  tokens: number,
): Measure {
  const price = frameReadPrice(frame, currency);
  return {
    measuredTokens: tokens,
    counterfactualTokens: PAGE_TOKENS,
    micros:
      price === null
        ? null
        : {
            measured: priceInputTokens(price, tokens),
            counterfactual: priceInputTokens(price, PAGE_TOKENS),
          },
    basis: frame.basis,
  };
}

function detect(input: DetectInput, ctx: DetectContext): void {
  for (const view of ctx.views) {
    const chains = chainsOf(input.frames?.get(view.run.runId));
    const compactions = compactionsByChain(
      input.compactions?.get(view.run.runId),
    );
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
      const chainKey = c.call.sessionUuid ?? "";
      const chain = chains?.get(chainKey);
      if (chain === undefined) {
        if (tokens <= UNPAGED_RESULT_TOKENS) continue;
        // The run's input price is its priced input cost over every input
        // token, so a run with an unpriced call reads low and is not covered.
        const measure = resultMeasure(view.run, tokens, () => PAGE_TOKENS);
        ctx.groups.add(
          key,
          input.toolWindowStart,
          view.run,
          partlyPriced(view.run) ? { ...measure, micros: null } : measure,
          [c.frame],
        );
        continue;
      }
      const carries = carriesOf(
        chain,
        timeOf(c.call),
        tokens,
        compactions.get(chainKey),
      );
      for (let i = 0; i < carries.length; i += 1)
        ctx.groups.add(
          key,
          input.toolWindowStart,
          view.run,
          carryMeasure(carries[i]!, view.run.currency, tokens),
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
