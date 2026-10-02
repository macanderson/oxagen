/**
 * Spin loops (detector 1, ADR-208): an agent that made the same call
 * `SPIN_LOOP_REPEATS` or more times in a row on one chain of a run, and got
 * the same result each time. A request counts when every tool call it made is
 * a repeat and one of them is in such a streak. Its whole priced cost counts
 * once, against nothing, and the finding claims its frame as detector 1. It
 * runs before retry loops, repeated shell commands, and duplicate tool calls,
 * so a request in a loop is counted once.
 *
 * The evidence counts every call a counted request made, as the repeat
 * findings do, so the Spend card's calls figure counts calls (#5023). The
 * price stays per request. The finding's values name the longest loop in one
 * cited run: its tool and how many times in a row it ran.
 */
import { addRequest } from "./repeats";
import {
  claimKey,
  onlyRepeats,
  type RunView,
  type ViewCall,
} from "./requests";
import {
  agentOrOperator,
  findingFingerprint,
  plural,
  requestMeasure,
  type DetectContext,
  type Detector,
  type DetectInput,
  type Group,
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

/** One loop: a streak of the same call on one chain, and its repeats. */
interface Loop {
  /** Every call of the streak, the first one too. */
  streak: readonly ViewCall[];
  repeats: readonly ViewCall[];
}

/**
 * The loops among a run's calls: on one chain, in seq order, a streak of the
 * same call with at least `SPIN_LOOP_REPEATS` repeats in it.
 */
function loopsOf(calls: readonly ViewCall[]): Loop[] {
  const chains = new Map<string, ViewCall[]>();
  for (const c of calls) {
    const chain = c.frame.sessionUuid ?? "";
    const list = chains.get(chain) ?? [];
    list.push(c);
    chains.set(chain, list);
  }
  const out: Loop[] = [];
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.frame.seq - b.frame.seq);
    let i = 0;
    while (i < chain.length) {
      let j = i + 1;
      while (j < chain.length && sameCall(chain[i]!, chain[j]!)) j += 1;
      const streak = chain.slice(i, j);
      const repeats = streak.filter((c) => c.repeat !== null);
      if (repeats.length >= SPIN_LOOP_REPEATS) out.push({ streak, repeats });
      i = j;
    }
  }
  return out;
}

/** The repeats that belong to a loop; see {@link loopsOf}. */
export function spinCalls(calls: readonly ViewCall[]): Set<ViewCall> {
  return new Set(loopsOf(calls).flatMap((loop) => loop.repeats));
}

/** The longest loop a finding cites: its tool, and how many times in a row it ran. */
interface Longest {
  tool: string;
  repeats: number;
}

/** The longer of two loops; on a tie, the tool that sorts first. */
function longer(a: Longest | undefined, b: Longest): Longest {
  if (a === undefined) return b;
  if (b.repeats !== a.repeats) return b.repeats > a.repeats ? b : a;
  return b.tool < a.tool ? b : a;
}

/** Each written group's longest loop, for its values. */
const longestOf = new WeakMap<Group, Longest>();

/**
 * Cite one run's loops. Returns the run's longest loop when the finding cites
 * the run, and null when it cites nothing of it.
 */
function detectRun(
  view: RunView,
  input: DetectInput,
  ctx: DetectContext,
): { fingerprint: string; longest: Longest } | null {
  const loops = loopsOf(view.calls);
  if (loops.length === 0) return null;
  const spin = new Set(loops.flatMap((loop) => loop.repeats));
  const run = view.run;
  const key = agentOrOperator("spin_loops", run);
  if (key === null) return null;
  const admitted = ctx.groups.admits(key, run);
  let cited = false;
  if (view.requests === null) {
    // No frames were read for the run: each looping call is cited, and
    // nothing prices it.
    for (const c of spin) {
      ctx.taken.add(c.call);
      if (!admitted) continue;
      ctx.groups.add(key, input.toolWindowStart, run, requestMeasure(null), [
        c.frame,
      ]);
      cited = true;
    }
  } else {
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
      // One cited item per call, and the request's price once.
      addRequest(
        key,
        input,
        run,
        request,
        request.frame === null ? null : { detector: 1, frame: request.frame },
        ctx,
      );
      cited = true;
    }
  }
  if (!cited) return null;
  let longest: Longest | undefined;
  for (const loop of loops)
    longest = longer(longest, {
      tool: loop.streak[0]!.call.tool,
      repeats: loop.streak.length,
    });
  return {
    fingerprint: findingFingerprint(key.kind, key.level, key.subject),
    longest: longest!,
  };
}

export const spinLoops: Detector = {
  kinds: ["spin_loops"],
  counting: 1,
  detect(input, ctx) {
    const byFingerprint = new Map<string, Longest>();
    for (const view of ctx.views) {
      const cited = detectRun(view, input, ctx);
      if (cited === null) continue;
      byFingerprint.set(
        cited.fingerprint,
        longer(byFingerprint.get(cited.fingerprint), cited.longest),
      );
    }
    for (const group of ctx.groups.values()) {
      if (group.kind !== "spin_loops") continue;
      const longest = byFingerprint.get(
        findingFingerprint(group.kind, group.level, group.subject),
      );
      if (longest !== undefined) longestOf.set(group, longest);
    }
  },
  prose: (group, evidence) => {
    const longest = longestOf.get(group);
    return {
      why: `On ${plural(group.runs.size, "run", "runs")}, a call ran ${SPIN_LOOP_REPEATS} or more times in a row and returned the same result each time. ${plural(evidence.calls, "call", "calls")} came from turns that made only those repeats.`,
      fix: `Tell the agent to change its approach when a call returns the same result twice, and stop the run after ${SPIN_LOOP_REPEATS} identical calls in a row.`,
      ...(longest === undefined
        ? {}
        : {
            values: {
              kind: "spin_loops" as const,
              tool: longest.tool,
              repeats: longest.repeats,
            },
          }),
    };
  },
};
