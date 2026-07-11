/**
 * Turn bisection (ADR-028) — `git bisect` for agent runs. Pure binary search
 * over turn indices; the caller supplies the probe (typically: restore the
 * tree at the probed turn into a scratch worktree, run a predicate command).
 */

export interface BisectProbe {
  turn: number;
  isGood: boolean;
}

export interface BisectResult {
  /** The first turn at which the predicate failed — the turn that doomed the run. */
  firstBadTurn: number;
  probes: BisectProbe[];
}

/**
 * Binary-search the first bad turn in (goodTurn, badTurn]. Preconditions the
 * caller asserts (or has probed): `goodTurn` is good, `badTurn` is bad, and
 * badness is monotonic (once doomed, stays doomed — same assumption git
 * bisect makes).
 *
 * `probe(turn)` returns true when the state AFTER `turn` is good. Called
 * O(log n) times.
 */
export async function bisectTurns(args: {
  goodTurn: number;
  badTurn: number;
  probe: (turn: number) => Promise<boolean>;
}): Promise<BisectResult> {
  let { goodTurn: low, badTurn: high } = args;
  if (!(Number.isInteger(low) && Number.isInteger(high)) || low >= high) {
    throw new Error(`bisect needs goodTurn < badTurn (got ${low} .. ${high})`);
  }
  const probes: BisectProbe[] = [];
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    const isGood = await args.probe(mid);
    probes.push({ turn: mid, isGood });
    if (isGood) low = mid;
    else high = mid;
  }
  return { firstBadTurn: high, probes };
}
