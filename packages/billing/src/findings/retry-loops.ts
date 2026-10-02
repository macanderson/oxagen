/**
 * Retry loops (detector 1, ADR-208): an agent that made the same call
 * `RETRY_LOOP_CALLS` or more times in a row on one chain of a run, and each
 * call failed with the same error class. A failed call returns no output, so
 * the repeat rule (../step-grade.ts) never matches it, and the request that
 * made it is still billed.
 *
 * In a streak, the first call is the attempt and every call after it is a
 * retry: the agent had already seen the call fail. A request counts when
 * every tool call it made is such a retry. Its whole priced cost counts once,
 * against nothing, and the finding claims its frame as detector 1. It runs
 * after spin loops and before repeated shell commands and duplicate tool
 * calls, so a request is counted once.
 *
 * A streak ends at any other call on its chain. It also ends where a mutating
 * call on another chain of the run, or a file change anywhere in the run,
 * falls between two of its calls, since the next call may then fail for a new
 * reason. A call with no input digest or no error class never joins a streak:
 * the hook recorded too little to show that two calls match.
 */
import { claimKey, type RunView, type ViewCall } from "./requests";
import {
  agentOrOperator,
  plural,
  requestMeasure,
  timeOf,
  type DetectContext,
  type Detector,
  type DetectInput,
  type ToolCallObservation,
} from "./shared";

/** A loop is this many identical failing calls in a row, or more. */
export const RETRY_LOOP_CALLS = 3;

/** The error class a call failed with, or null when it cannot join a streak. */
function failureOf(c: ToolCallObservation): string | null {
  if (c.status !== "error" && c.status !== "rejected") return null;
  if (c.inputDigest === "") return null;
  if (c.errorClass === undefined || c.errorClass === null) return null;
  if (c.errorClass === "") return null;
  return c.errorClass;
}

function sameFailure(a: ToolCallObservation, b: ToolCallObservation): boolean {
  const failure = failureOf(a);
  return (
    failure !== null &&
    failure === failureOf(b) &&
    a.tool === b.tool &&
    a.inputDigest === b.inputDigest
  );
}

/** A step that can change what a call returns: a mutating call, or a file change. */
interface Breaker {
  at: number;
  /** The chain a mutating call ran on; null for a file change, which counts on every chain. */
  chain: string | null;
}

function chainOf(c: ToolCallObservation): string {
  return c.sessionUuid ?? "";
}

/**
 * The retries among one run's calls: on each chain in seq order, every call
 * after the first of a streak of at least `RETRY_LOOP_CALLS` identical
 * failures. `fileChanges` holds the run's file change times in microseconds,
 * and `from` is where that read begins: a pair of calls that starts before
 * it cannot be shown to have no change between them, so it ends the streak.
 */
export function retryCalls(
  calls: readonly ToolCallObservation[],
  fileChanges: readonly number[],
  from: Date,
): Set<ToolCallObservation> {
  const fromMicros = from.getTime() * 1000;
  const breakers: Breaker[] = fileChanges.map((at) => ({ at, chain: null }));
  const chains = new Map<string, ToolCallObservation[]>();
  for (const c of calls) {
    // A call the classifier could not place may write, so it counts.
    if (c.isMutating !== false)
      breakers.push({ at: timeOf(c), chain: chainOf(c) });
    const list = chains.get(chainOf(c)) ?? [];
    list.push(c);
    chains.set(chainOf(c), list);
  }
  breakers.sort((a, b) => a.at - b.at);

  // Whether anything that can change the outcome falls between two calls of
  // one chain. The bounds are inclusive: a step at the same instant as
  // either call may have run between them.
  const broken = (a: ToolCallObservation, b: ToolCallObservation): boolean => {
    const start = timeOf(a);
    const end = timeOf(b);
    if (start < fromMicros) return true;
    let lo = 0;
    let hi = breakers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breakers[mid]!.at < start) lo = mid + 1;
      else hi = mid;
    }
    const chain = chainOf(a);
    for (let i = lo; i < breakers.length && breakers[i]!.at <= end; i += 1)
      if (breakers[i]!.chain !== chain) return true;
    return false;
  };

  const out = new Set<ToolCallObservation>();
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.seq - b.seq);
    let i = 0;
    while (i < chain.length) {
      let j = i + 1;
      while (
        j < chain.length &&
        sameFailure(chain[i]!, chain[j]!) &&
        !broken(chain[j - 1]!, chain[j]!)
      )
        j += 1;
      if (j - i >= RETRY_LOOP_CALLS)
        for (let k = i + 1; k < j; k += 1) out.add(chain[k]!);
      i = j;
    }
  }
  return out;
}

/**
 * Per run, how many of its calls are retries in a loop. The store reads
 * model-call frames for these runs as it does for runs with repeats. Absent
 * file change times read as none, since the count only ranks the reads.
 */
export function runsWithRetries(
  calls: readonly ToolCallObservation[],
  fileChangeTimes: DetectInput["fileChangeTimes"],
): Map<string, number> {
  const byRun = new Map<string, ToolCallObservation[]>();
  for (const c of calls) {
    const list = byRun.get(c.runId) ?? [];
    list.push(c);
    byRun.set(c.runId, list);
  }
  const out = new Map<string, number>();
  for (const [runId, list] of byRun) {
    const n = retryCalls(
      list,
      fileChangeTimes?.byRun.get(runId) ?? [],
      fileChangeTimes?.from ?? new Date(0),
    ).size;
    if (n > 0) out.set(runId, n);
  }
  return out;
}

function detectRun(
  view: RunView,
  input: DetectInput,
  ctx: DetectContext,
  fileChangeTimes: NonNullable<DetectInput["fileChangeTimes"]>,
): void {
  const retries = retryCalls(
    view.calls.map((c) => c.call),
    fileChangeTimes.byRun.get(view.run.runId) ?? [],
    fileChangeTimes.from,
  );
  if (retries.size === 0) return;
  const run = view.run;
  const key = agentOrOperator("retry_loops", run);
  if (key === null) return;
  const admitted = ctx.groups.admits(key, run);
  const isRetry = (c: ViewCall) => retries.has(c.call);
  if (view.requests === null) {
    // No frames were read for the run: each retry is cited, and nothing
    // prices it.
    for (const c of view.calls) {
      if (!isRetry(c) || ctx.taken.has(c.call)) continue;
      ctx.taken.add(c.call);
      if (admitted)
        ctx.groups.add(key, input.toolWindowStart, run, requestMeasure(null), [
          c.frame,
        ]);
    }
    return;
  }
  for (const request of view.requests) {
    if (
      request.calls.length === 0 ||
      !request.calls.every(isRetry) ||
      request.calls.some((c) => ctx.taken.has(c.call))
    )
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

export const retryLoops: Detector = {
  kinds: ["retry_loops"],
  counting: 1,
  detect(input, ctx) {
    // Without the file change read, no streak can be shown to have nothing
    // between its calls, so the detector writes nothing.
    const fileChangeTimes = input.fileChangeTimes;
    if (fileChangeTimes === undefined) return;
    for (const view of ctx.views) detectRun(view, input, ctx, fileChangeTimes);
  },
  prose: (group, evidence) => ({
    why: `On ${plural(group.runs.size, "run", "runs")}, a call failed ${RETRY_LOOP_CALLS} or more times in a row with the same error, and no write or file change came between the attempts. ${plural(evidence.calls, "turn", "turns")} made only those retries.`,
    fix: "Tell the agent to read the error and change the call or the files it depends on before it tries again. A call that fails the same way twice needs a different approach.",
  }),
};
