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
 *
 * A result a later step quoted was used (decision 7, ./result-use.ts). Its
 * re-reads stay cited, priced against themselves, so they add nothing to the
 * saving, and the prose shows them apart. A result with no verdict counts in
 * full, as every result did before the signal: on a `digest_only` workspace,
 * where a body did not read back, or where the store read no signal. The
 * prose labels that part an upper bound.
 */
import {
  priceInputTokens,
  type InputPrice,
  type RunTotalsRecord,
} from "../cost-rollup";
import { currencyOf, formatMicros } from "./cache-steps";
import type { ViewCall } from "./requests";
import { resultUseKey, type ResultUseRead } from "./result-use";
import {
  findingFingerprint,
  PAGE_TOKENS,
  plural,
  resultMeasure,
  timeOf,
  UNPAGED_RESULT_TOKENS,
  type CallFrame,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type FindingResultUse,
  type Group,
  type Measure,
  type PricedRequestFrame,
  type RunCompaction,
  type ToolCallObservation,
} from "./shared";

/** A result above this many tokens is priced for every request that re-reads it. */
export const CARRY_RESULT_TOKENS = 5_000;

/** A price book entry is in micro-units per million tokens. */
const MILLION = 1_000_000n;

/**
 * The calls whose results this detector can price, so the store checks only
 * them for a quote: a result over `CARRY_RESULT_TOKENS` on a run whose frames
 * were read, and a result over `UNPAGED_RESULT_TOKENS` on any run.
 */
export function resultsToCheck(
  calls: readonly ToolCallObservation[],
  frames: ReadonlyMap<string, unknown>,
): ToolCallObservation[] {
  return calls.filter(
    (c) =>
      c.resultTokens !== null &&
      (c.resultTokens > UNPAGED_RESULT_TOKENS ||
        (c.resultTokens > CARRY_RESULT_TOKENS && frames.has(c.runId))),
  );
}

/** A large result's side of the split: a later step quoted it, none did, or it has no verdict. */
type ResultSide = "used" | "unused" | "unchecked";

function sideOf(
  read: ResultUseRead | undefined,
  call: ToolCallObservation,
): ResultSide {
  if (read === undefined || read.mode !== "content_exact") return "unchecked";
  return read.verdicts.get(resultUseKey(call)) ?? "unchecked";
}

interface SideTally {
  results: number;
  reads: number;
  pageSavingMicros: bigint;
}

type Split = Record<ResultSide, SideTally>;

function emptySplit(): Split {
  const side = (): SideTally => ({
    results: 0,
    reads: 0,
    pageSavingMicros: 0n,
  });
  return { used: side(), unused: side(), unchecked: side() };
}

/** Each finding's split, for its prose. */
const splitOf = new WeakMap<Group, FindingResultUse>();

/**
 * A used result's re-read: cited at what it cost, against that same cost,
 * so it saves nothing.
 */
function usedMeasure(measure: Measure): Measure {
  return {
    ...measure,
    counterfactualTokens: measure.measuredTokens,
    micros:
      measure.micros === null
        ? null
        : {
            measured: measure.micros.measured,
            counterfactual: measure.micros.measured,
          },
  };
}

/** What paging a re-read would save; zero when no price covers it. */
function pageSaving(measure: Measure): bigint {
  return measure.micros === null
    ? 0n
    : measure.micros.measured - measure.micros.counterfactual;
}

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
 * chain's own, `chain` is in time order, and `seq` is the call's position on
 * the chain.
 *
 * A frame at the compaction's own instant is taken to come after it. The store
 * keeps a wrapped run's instants to the millisecond, so a compaction can share
 * the call's instant. The chain's `seq` then orders the two: a compaction at
 * that instant with a later `seq` ends the carry before any frame (#4585).
 * Between compactions a chain's input context only grows, so a drop that large means
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
  seq?: number,
): PricedRequestFrame[] {
  let end = Number.POSITIVE_INFINITY;
  for (const c of compactions) {
    const t = timeOf(c);
    const after = t > at || (t === at && seq !== undefined && c.seq > seq);
    if (after && t < end) end = t;
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
  const splits = new Map<string, Split>();
  /** Add one re-read of a result on its side of the split. */
  const addRead = (
    key: FindingKey,
    run: RunTotalsRecord,
    measure: Measure,
    frames: readonly CallFrame[],
    side: ResultSide,
    first: boolean,
  ) => {
    ctx.groups.add(
      key,
      input.toolWindowStart,
      run,
      side === "used" ? usedMeasure(measure) : measure,
      frames,
    );
    const fingerprint = findingFingerprint(key.kind, key.level, key.subject);
    const split = splits.get(fingerprint) ?? emptySplit();
    splits.set(fingerprint, split);
    const tally = split[side];
    if (first) tally.results += 1;
    tally.reads += 1;
    // The same rule as `Groups.add`: a re-read counts toward the figure only
    // when a price and a basis cover it.
    const basis = measure.basis === undefined ? run.costBasis : measure.basis;
    if (basis !== null) tally.pageSavingMicros += pageSaving(measure);
  };
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
      const side = sideOf(input.resultUse, c.call);
      const chainKey = c.call.sessionUuid ?? "";
      const chain = chains?.get(chainKey);
      if (chain === undefined) {
        if (tokens <= UNPAGED_RESULT_TOKENS) continue;
        // The run's input price is its priced input cost over every input
        // token, so a run with an unpriced call reads low and is not covered.
        const measure = resultMeasure(view.run, tokens, () => PAGE_TOKENS);
        addRead(
          key,
          view.run,
          partlyPriced(view.run) ? { ...measure, micros: null } : measure,
          [c.frame],
          side,
          true,
        );
        continue;
      }
      const carries = carriesOf(
        chain,
        timeOf(c.call),
        tokens,
        compactions.get(chainKey),
        c.call.seq,
      );
      for (let i = 0; i < carries.length; i += 1)
        addRead(
          key,
          view.run,
          carryMeasure(carries[i]!, view.run.currency, tokens),
          i === 0 ? [c.frame] : [],
          side,
          i === 0,
        );
    }
  }
  const mode = input.resultUse?.mode ?? null;
  for (const group of ctx.groups.values()) {
    if (group.kind !== "unpaged_results") continue;
    const split = splits.get(
      findingFingerprint(group.kind, group.level, group.subject),
    );
    if (split === undefined) continue;
    const tally = (t: SideTally) => ({
      results: t.results,
      reads: t.reads,
      pageSavingMicros: t.pageSavingMicros.toString(),
    });
    const resultUse: FindingResultUse = {
      mode,
      used: tally(split.used),
      unused: tally(split.unused),
      unchecked: tally(split.unchecked),
    };
    group.resultUse = resultUse;
    splitOf.set(group, resultUse);
  }
}

/** Its or their, for a count of results. */
function their(n: number): string {
  return n === 1 ? "its" : "their";
}

/**
 * The sentences after the spec's finding text: which results a later step
 * quoted, which no step did, and which part is an upper bound. On a
 * `content_exact` workspace a used result is named apart, with what paging it
 * would have saved, since that figure is left out of the amount.
 */
function useLines(split: FindingResultUse, currency: string): string {
  if (split.mode !== "content_exact")
    return split.mode === "digest_only"
      ? " Upper bound: Oxagen checks for a quote only where a workspace keeps both tool call and model call text, and this one does not. This figure counts every re-read."
      : " Upper bound: no later step was checked for a quote of these results. This figure counts every re-read.";
  const { used, unused, unchecked } = split;
  const lines: string[] = [];
  if (unused.results > 0)
    lines.push(
      `No later step quoted ${plural(unused.results, "result", "results")}, which later requests read ${plural(unused.reads, "time", "times")}.`,
    );
  if (used.results > 0)
    lines.push(
      `A later step quoted ${plural(used.results, "result", "results")}. This figure leaves out ${their(used.results)} ${plural(used.reads, "re-read", "re-reads")}, which paging would have cut by ${formatMicros(BigInt(used.pageSavingMicros), currency)}.`,
    );
  if (unchecked.results > 0)
    lines.push(
      `Upper bound: ${plural(unchecked.results, "result", "results")} could not be checked for a quote, so this figure counts ${their(unchecked.results)} ${plural(unchecked.reads, "re-read", "re-reads")} in full.`,
    );
  return lines.length === 0 ? "" : ` ${lines.join(" ")}`;
}

export const unpagedResults: Detector = {
  kinds: ["unpaged_results"],
  counting: null,
  detect,
  prose: (group, evidence) => {
    let results = 0;
    for (const cited of Object.values(evidence.frames ?? {}))
      results += cited.total;
    const split = splitOf.get(group);
    // The request right after a call is the first to read its result, so
    // the prose says "read": a result priced without frames counts that one.
    const why = `${group.subject} returned ${plural(results, "result", "results")} over ${CARRY_RESULT_TOKENS.toLocaleString("en-US")} tokens on ${plural(group.runs.size, "run", "runs")}. Later requests read ${results === 1 ? "it" : "them"} ${plural(evidence.calls, "time", "times")}.`;
    const fix = `Page ${group.subject}'s results at ${PAGE_TOKENS.toLocaleString("en-US")} tokens and fetch the rest on demand. A step that needs a large result once can run in a subagent, so the result stays out of the run's own context.`;
    return {
      why: split === undefined ? why : why + useLines(split, currencyOf(group)),
      fix:
        split?.mode === "digest_only"
          ? `${fix} To leave out the results a later step quoted, keep tool call and model call text in the workspace's retention policy.`
          : fix,
    };
  },
};
