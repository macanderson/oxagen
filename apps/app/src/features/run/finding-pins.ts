// Where the Cost tab pins each finding that cites the run (#4001): the turn
// each cited frame falls in.
//
// A frame on the run's own chain falls in the last turn whose opening `seq` is
// at or below it, because a turn holds every root frame from its opening
// frame to the next turn's. A frame on a subagent chain falls in the turn
// `get_run_turns` placed that chain in (`chains`), because a subagent's seq
// counts on its own chain. A finding that cites the run as a whole, and one
// whose frames were not recorded or fall in no drawn turn, is pinned to the
// run: the total row, never a guessed turn.
import type { RunFindings, RunTurns } from "@/data/contracts/run";

export type PinnedFinding = RunFindings["findings"][number];

export type FindingPins = {
  /** The findings citing each turn, in the order the read listed them. */
  byTurn: ReadonlyMap<number, readonly PinnedFinding[]>;
  /** Findings pinned to the run as a whole. */
  run: readonly PinnedFinding[];
};

/**
 * Orders two frame seqs, digit strings up to 19 long, without a float: by
 * length once leading zeros are gone, then by digit.
 */
function compareSeqs(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The turn a root-chain seq falls in; null before the first turn opens. */
function rootTurnOf(
  turns: readonly { turn: number; seq: string }[],
  seq: string,
): number | null {
  let found: number | null = null;
  for (const t of turns) if (compareSeqs(t.seq, seq) <= 0) found = t.turn;
  return found;
}

export function pinsOf(
  turns: readonly { turn: number; seq: string }[],
  chains: RunTurns["chains"],
  findings: RunFindings["findings"],
): FindingPins {
  const ordered = [...turns].sort((a, b) => compareSeqs(a.seq, b.seq));
  const drawn = new Set(ordered.map((t) => t.turn));
  const chainTurn = new Map(chains.map((c) => [c.sessionUuid, c.turn]));
  const byTurn = new Map<number, PinnedFinding[]>();
  const run: PinnedFinding[] = [];
  for (const finding of findings) {
    const { citation } = finding;
    const placed = new Set<number>();
    if (!citation.runLevel && citation.frames !== null)
      for (const frame of citation.frames) {
        const turn =
          frame.sessionUuid === undefined
            ? rootTurnOf(ordered, frame.seq)
            : (chainTurn.get(frame.sessionUuid) ?? null);
        if (turn !== null && drawn.has(turn)) placed.add(turn);
      }
    if (placed.size === 0) {
      run.push(finding);
      continue;
    }
    for (const turn of placed)
      byTurn.set(turn, [...(byTurn.get(turn) ?? []), finding]);
  }
  return { byTurn, run };
}
