/**
 * Spin loops (detector 1, ADR-208): an agent that made the same call
 * `SPIN_LOOP_REPEATS` or more times in a row on one chain of a run, and got
 * the same result each time. A request counts when every tool call it made is
 * a repeat and one of them is in such a streak. Its whole priced cost counts
 * once, against nothing, and the finding claims its frame as detector 1. It
 * runs before repeated shell commands and duplicate tool calls, so a request
 * in a loop is never counted twice.
 */
import {
  claimKey,
  onlyRepeats,
  type RunView,
  type ViewCall,
} from "./requests";
import {
  agentOrOperator,
  plural,
  requestMeasure,
  type DetectContext,
  type Detector,
  type DetectInput,
} from "./shared";

/** A loop is this many repeats of one call in a row, or more. */
export const SPIN_LOOP_REPEATS = 20;

function sameCall(a: ViewCall, b: ViewCall): boolean {
  return (
    a.call.tool === b.call.tool &&
    a.call.inputDigest === b.call.inputDigest &&
    a.call.outputDigest === b.call.outputDigest
  );
}

/**
 * The repeats that belong to a loop: on one chain, in seq order, a streak of
 * the same call with at least `SPIN_LOOP_REPEATS` repeats in it.
 */
export function spinCalls(calls: readonly ViewCall[]): Set<ViewCall> {
  const chains = new Map<string, ViewCall[]>();
  for (const c of calls) {
    const chain = c.frame.sessionUuid ?? "";
    const list = chains.get(chain) ?? [];
    list.push(c);
    chains.set(chain, list);
  }
  const out = new Set<ViewCall>();
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.frame.seq - b.frame.seq);
    let i = 0;
    while (i < chain.length) {
      let j = i + 1;
      while (j < chain.length && sameCall(chain[i]!, chain[j]!)) j += 1;
      const repeats = chain.slice(i, j).filter((c) => c.repeat !== null);
      if (repeats.length >= SPIN_LOOP_REPEATS)
        for (const c of repeats) out.add(c);
      i = j;
    }
  }
  return out;
}

function detectRun(
  view: RunView,
  input: DetectInput,
  ctx: DetectContext,
): void {
  const spin = spinCalls(view.calls);
  if (spin.size === 0) return;
  const run = view.run;
  const key = agentOrOperator("spin_loops", run);
  if (key === null) return;
  const admitted = ctx.groups.admits(key, run);
  if (view.requests === null) {
    // No frames were read for the run: each looping call is cited, and
    // nothing prices it.
    for (const c of spin) {
      ctx.taken.add(c.call);
      if (admitted)
        ctx.groups.add(key, input.toolWindowStart, run, requestMeasure(null), [
          c.frame,
        ]);
    }
    return;
  }
  for (const request of view.requests) {
    if (!onlyRepeats(request) || !request.calls.some((c) => spin.has(c)))
      continue;
    if (request.frame !== null) {
      const claim = claimKey(run.runId, request.frame.key);
      if (ctx.claimed.has(claim)) continue;
      ctx.claimed.add(claim);
    }
    for (const c of request.calls) ctx.taken.add(c.call);
    if (!admitted) continue;
    ctx.groups.add(
      key,
      input.toolWindowStart,
      run,
      requestMeasure(request.frame),
      request.calls.map((c) => c.frame),
      request.frame === null ? null : { detector: 1, frame: request.frame },
    );
  }
}

export const spinLoops: Detector = {
  kinds: ["spin_loops"],
  counting: 1,
  detect(input, ctx) {
    for (const view of ctx.views) detectRun(view, input, ctx);
  },
  prose: (group, evidence) => ({
    why: `On ${plural(group.runs.size, "run", "runs")}, a call ran ${SPIN_LOOP_REPEATS} or more times in a row and returned the same result each time. ${plural(evidence.calls, "turn", "turns")} made only those repeats.`,
    fix: `Tell the agent to change its approach when a call returns the same result twice, and stop the run after ${SPIN_LOOP_REPEATS} identical calls in a row.`,
  }),
};
