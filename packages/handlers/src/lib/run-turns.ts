// run-turns.ts — a run's per-turn ledger (`get_run_turns`, #4067), built two
// ways that must agree.
//
// A ledger run is read frame by frame here (`framesTurns`), because the
// ledger store is Postgres and its runs are small. Its steps are the
// transcript's own: the one step fold in `@oxagen/run-ledger` (ADR-182),
// counted per turn, so a turn here holds the steps the Run page draws.
//
// A wrapped run is counted in ClickHouse (`selectTachoTurnGroups`): each chain
// comes back tallied per turn, and `tachoTurns` below places every subagent
// chain in the turn that spawned it and adds the tallies up. The fold cannot
// serve that read: a wrapped run can pass 250,000 frames and the fold reads at
// most 10,000 (#4067). So the SQL counts steps by the fold's rules, spelled
// for the store, and reads the fold's own vocabulary for the one rule that
// depends on frame order, rule 3 (`UNKEYED_TOOL_PAIRING`, ADR-191).
// `framesTurns` over a wrapped run's spliced frames is the reference the
// ClickHouse path is tested against (`run.turns.get.integration.test.ts`),
// including the unkeyed tool calls whose halves are not adjacent (#4308).
//
// A turn is what `turnOrdinals` says it is, the numbering the transcript's
// entries carry, so a turn here and a turn there are the same turn.
import type { RunTurn } from "@oxagen/oxagen/contracts/run.turns.get";
import {
  type RunFrame,
  stepFolds,
  tachoTimestamp,
  turnOrdinals,
  withoutDuplicateModelCalls,
} from "@oxagen/run-ledger";
import type {
  TachoChainTurnFacts,
  TachoSpawnFact,
  TachoTurnGroup,
} from "@oxagen/telemetry";
import { microsString } from "../run.list";

/** One chain's frames within one turn, as the ClickHouse path tallies them. */
export interface TurnTally {
  frames: number;
  /** Model calls, each once: `llm_call` frames that are no later sighting of a call. */
  modelCalls: number;
  /** Tool calls by call id. */
  keyedToolCalls: number;
  /** Tool calls with no call id, paired by the fold's rule 3 in the query. */
  unkeyedToolCalls: number;
  costMicros: number | null;
  inputUncached: number | null;
  cacheRead: number | null;
}

const addNullable = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b;

/** One chain's tool calls: each call id, and each unkeyed call rule 3 found. */
const toolSteps = (t: TurnTally) => t.keyedToolCalls + t.unkeyedToolCalls;

/** What one turn adds up to, across its chains. */
interface TurnSum {
  frames: number;
  modelSteps: number;
  toolSteps: number;
  costMicros: number | null;
  inputUncached: number | null;
  cacheRead: number | null;
}

function sumOf(tallies: readonly TurnTally[]): TurnSum {
  const out: TurnSum = {
    frames: 0,
    modelSteps: 0,
    toolSteps: 0,
    costMicros: null,
    inputUncached: null,
    cacheRead: null,
  };
  for (const t of tallies) {
    out.frames += t.frames;
    // Halves pair within a chain, never across two: the query counts each
    // chain's steps on their own, and they are added here.
    out.modelSteps += t.modelCalls;
    out.toolSteps += toolSteps(t);
    out.costMicros = addNullable(out.costMicros, t.costMicros);
    out.inputUncached = addNullable(out.inputUncached, t.inputUncached);
    out.cacheRead = addNullable(out.cacheRead, t.cacheRead);
  }
  return out;
}

const usd = (micros: number | null) =>
  micros === null
    ? null
    : {
        micros: microsString(micros),
        currency: "USD",
        basis: "client_attested" as const,
      };

/** A turn as the contract answers it. */
interface TurnOpening {
  turn: number;
  seq: string;
  at: Date;
}

/**
 * The contract's rows from each turn's opening and sum, in turn order.
 * `before` is the cost recorded before the first turn, which the run's cost so
 * far already holds when turn 1 opens.
 */
function rowsOf(
  turns: readonly { opening: TurnOpening; sum: TurnSum }[],
  before: number | null,
): RunTurn[] {
  let spent = before;
  return turns.map(({ opening, sum }) => {
    spent = addNullable(spent, sum.costMicros);
    return {
      turn: opening.turn,
      seq: opening.seq,
      at: opening.at.toISOString(),
      frames: sum.frames,
      modelSteps: sum.modelSteps,
      toolSteps: sum.toolSteps,
      cost: usd(sum.costMicros),
      cumulativeCost: usd(spent),
      tokens: { inputUncached: sum.inputUncached, cacheRead: sum.cacheRead },
    };
  });
}

// ── From frames ──────────────────────────────────────────────────────────────

/**
 * Model and tool steps per turn, as the transcript's `steps` zoom folds them.
 *
 * The fold reads what the transcript shows: one model call reported by
 * several sources is one step (`withoutDuplicateModelCalls`). That read moves
 * a hidden sighting's spend onto the copy it keeps, so it runs over copies of
 * the frames, and the frames `framesTurns` tallies keep the spend they were
 * read with.
 */
function stepsByTurn(
  frames: readonly RunFrame[],
): Map<number, { model: number; tool: number }> {
  const shown = withoutDuplicateModelCalls(
    frames.map((frame) => ({ ...frame })),
  );
  const out = new Map<number, { model: number; tool: number }>();
  for (const step of stepFolds(shown)) {
    if (step.turn === null) continue;
    const counted = out.get(step.turn) ?? { model: 0, tool: 0 };
    if (step.node === "model") counted.model += 1;
    else if (step.node === "tool") counted.tool += 1;
    out.set(step.turn, counted);
  }
  return out;
}

/**
 * The per-turn ledger of `frames`, in the order a run's frames are read (for
 * a wrapped run, each subagent chain spliced in where it was spawned).
 *
 * A turn opens at its first frame on the run's own chain. A subagent chain
 * spliced ahead of it numbers its seqs on its own chain, so its seq would
 * point at a different frame of the run.
 *
 * The caller has already removed the cost and usage of a harness's late
 * report (`withoutLateReports` in `@oxagen/run-ledger`). A later sighting of
 * a model call already carries no cost (`tachoFrame`), and its usage is not
 * counted here.
 */
export function framesTurns(
  frames: readonly RunFrame[],
  cap: number,
): { turns: RunTurn[]; complete: boolean } {
  const ordinals = turnOrdinals(frames);
  const steps = stepsByTurn(frames);
  let before: number | null = null;
  const byTurn = new Map<
    number,
    {
      opening: TurnOpening;
      /** Whether `opening` is a frame on the run's own chain. */
      rooted: boolean;
      sum: TurnSum;
    }
  >();
  frames.forEach((frame, i) => {
    const turn = ordinals[i] ?? null;
    if (turn === null) {
      before = addNullable(before, frame.costMicros);
      return;
    }
    const rooted = frame.chain === undefined;
    let entry = byTurn.get(turn);
    if (entry === undefined) {
      const counted = steps.get(turn);
      entry = {
        opening: { turn, seq: frame.seq, at: frame.observedAt },
        rooted,
        sum: {
          frames: 0,
          modelSteps: counted?.model ?? 0,
          toolSteps: counted?.tool ?? 0,
          costMicros: null,
          inputUncached: null,
          cacheRead: null,
        },
      };
      byTurn.set(turn, entry);
    } else if (rooted && !entry.rooted) {
      entry.opening = { turn, seq: frame.seq, at: frame.observedAt };
      entry.rooted = true;
    }
    const { sum } = entry;
    sum.frames += 1;
    sum.costMicros = addNullable(sum.costMicros, frame.costMicros);
    if ((frame.llmCall?.duplicateOf ?? null) === null) {
      sum.inputUncached = addNullable(
        sum.inputUncached,
        frame.usage?.inputUncached ?? null,
      );
      sum.cacheRead = addNullable(
        sum.cacheRead,
        frame.usage?.cacheRead ?? null,
      );
    }
  });
  const turns = [...byTurn.values()].map(({ opening, sum }) => ({
    opening,
    sum,
  }));
  return {
    turns: rowsOf(turns.slice(0, cap), before),
    complete: turns.length <= cap,
  };
}

// ── From ClickHouse ─────────────────────────────────────────────────────────

/**
 * The root seqs a wrapped run's turns open on: its `turn_start` frames, or,
 * for a recording with none, its first frame and every frame where the
 * recorded turn index first takes a new value. The first value the index
 * takes opens nothing of its own: the run's first frame already opened turn
 * 1 (`foldTranscript`'s `turns` zoom). Empty for a root with no frames.
 */
export function tachoTurnStarts(root: TachoChainTurnFacts | undefined): {
  starts: number[];
  boundaries: "turn_start" | "turn_index";
} {
  if (root === undefined) return { starts: [], boundaries: "turn_start" };
  if (root.turnStarts.length > 0)
    return { starts: root.turnStarts, boundaries: "turn_start" };
  return {
    starts: [
      ...new Set([root.firstSeq, ...root.turnIndexStarts.slice(1)]),
    ].sort((a, b) => a - b),
    boundaries: "turn_index",
  };
}

const tallyOf = (g: TachoTurnGroup): TurnTally => ({
  frames: g.frames,
  modelCalls: g.modelCalls,
  keyedToolCalls: g.keyedToolCalls,
  unkeyedToolCalls: g.unkeyedToolCalls,
  costMicros: g.costMicros,
  inputUncached: g.inputUncached,
  cacheRead: g.cacheRead,
});

/** A turn index, or null for the frames before the first turn. */
type Placement = number | null;

/**
 * The turn each subagent chain's frames fall in, by the rule
 * `spliceSubagentChains` places a chain with: directly after the
 * `subagent_start` that spawned it, matched on the spawning tool call's id and
 * then on the subagent's id, or, when no spawn matches, before the first
 * frame of its parent recorded after the chain's own first frame. A chain
 * spawned by another subagent sits inside its parent's chain, so it falls in
 * the parent's turn. A chain caught in a cycle of recorded parents is placed
 * after every frame of the run, in its last turn.
 *
 * `rootTurns` are the root's turns in order, each with its index, its first
 * frame's time, and the spawns recorded in it; `beforeSpawns` are the spawns
 * recorded before the first turn.
 */
export function placeChains(args: {
  chains: readonly TachoTurnGroup[];
  rootTurns: readonly { index: number; at: number; spawns: TachoSpawnFact[] }[];
  beforeSpawns: readonly TachoSpawnFact[];
}): Map<string, Placement> {
  const chains = new Map(args.chains.map((g) => [g.sessionUuid, g]));
  const ROOT = "";
  const parentOf = (id: string): string => {
    const parent = chains.get(id)?.parentSessionUuid ?? null;
    return parent !== null && chains.has(parent) && parent !== id
      ? parent
      : ROOT;
  };
  const placed = new Map<string, Placement>();

  const began = (id: string): number =>
    tachoTimestamp(chains.get(id)?.firstAt ?? "").getTime();
  // The chains the root holds directly, matched to the root's spawns in the
  // order the spawns were recorded. Where two chains could answer one spawn,
  // the one that began first is tried first, then the lower session id: the
  // order `spliceSubagentChains` tries them in, so a chain falls in the same
  // turn here and on the transcript.
  const candidates = [...chains.keys()]
    .filter((id) => parentOf(id) === ROOT)
    .sort((a, b) => began(a) - began(b) || (a < b ? -1 : a > b ? 1 : 0));
  const taken = new Set<string>();
  const spawns: { spawn: TachoSpawnFact; turn: Placement }[] = [
    ...args.beforeSpawns.map((spawn) => ({ spawn, turn: null })),
    ...args.rootTurns.flatMap((t) =>
      t.spawns.map((spawn) => ({ spawn, turn: t.index })),
    ),
  ].sort((a, b) => a.spawn.seq - b.spawn.seq);
  const match = (
    same: (chain: TachoTurnGroup) => boolean,
  ): string | undefined =>
    candidates.find((id) => {
      const chain = chains.get(id);
      return !taken.has(id) && chain !== undefined && same(chain);
    });
  for (const { spawn, turn } of spawns) {
    const hit =
      (spawn.toolUseId === null
        ? undefined
        : match((chain) => chain.spawnToolUseId === spawn.toolUseId)) ??
      (spawn.subagentId === null
        ? undefined
        : match((chain) => chain.subagentId === spawn.subagentId));
    if (hit !== undefined) {
      taken.add(hit);
      placed.set(hit, turn);
    }
  }
  // A chain no spawn names goes in the turn in progress when it began.
  for (const id of candidates) {
    if (taken.has(id)) continue;
    const at = began(id);
    let turn: Placement = null;
    for (const t of args.rootTurns) if (t.at <= at) turn = t.index;
    placed.set(id, turn);
  }
  // A chain inside another falls in that chain's turn.
  const last = args.rootTurns.at(-1)?.index ?? null;
  const placeOf = (id: string, seen: Set<string>): Placement => {
    const known = placed.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return last;
    seen.add(id);
    const parent = chains.get(id)?.parentSessionUuid ?? null;
    const turn = parent === null ? last : placeOf(parent, seen);
    placed.set(id, turn);
    return turn;
  };
  for (const id of chains.keys()) placeOf(id, new Set());
  return placed;
}

/**
 * A wrapped run's per-turn ledger from its ClickHouse tallies.
 *
 * `starts` are the root seqs its turns open on (`tachoTurnStarts`), and every
 * root group's key is one of them, or null for the frames before the first.
 * Each subagent chain is one group, placed by `placeChains`.
 *
 * `boundaries` says how the starts were found. A recording whose turns open
 * at `turn_start` frames has frames before its first turn. One whose turns
 * follow the recorded turn index has none: its first frame opens turn 1,
 * whichever chain recorded it, so a chain placed before every root frame is
 * in turn 1.
 *
 * `chains` answers the turn each subagent chain counts toward (#4001), so a
 * reader holding a subagent frame's seq can find its turn. A chain in no
 * turn, or in a turn past the cap, is left out: the list names only turns
 * `turns` holds.
 */
export function tachoTurns(args: {
  rootSessionUuid: string;
  starts: readonly number[];
  boundaries: "turn_start" | "turn_index";
  groups: readonly TachoTurnGroup[];
  cap: number;
}): {
  turns: RunTurn[];
  complete: boolean;
  chains: { sessionUuid: string; turn: number }[];
} {
  const index = new Map(args.starts.map((seq, i) => [seq, i + 1]));
  const rootTurns: {
    index: number;
    group: TachoTurnGroup;
    at: number;
  }[] = [];
  let before: TachoTurnGroup | undefined;
  const chains: TachoTurnGroup[] = [];
  for (const group of args.groups) {
    if (group.sessionUuid !== args.rootSessionUuid) chains.push(group);
    else if (group.turnKey === null) before = group;
    else {
      const turn = index.get(group.turnKey);
      if (turn !== undefined)
        rootTurns.push({
          index: turn,
          group,
          at: tachoTimestamp(group.firstAt).getTime(),
        });
    }
  }
  rootTurns.sort((a, b) => a.index - b.index);
  const placed = placeChains({
    chains,
    rootTurns: rootTurns.map((t) => ({
      index: t.index,
      at: t.at,
      spawns: t.group.spawns,
    })),
    beforeSpawns: before?.spawns ?? [],
  });
  const inTurn = new Map<Placement, TurnTally[]>();
  const first: Placement = args.boundaries === "turn_index" ? 1 : null;
  const shown = new Set(rootTurns.slice(0, args.cap).map((t) => t.index));
  const chainTurns: { sessionUuid: string; turn: number }[] = [];
  for (const chain of chains) {
    const turn = placed.get(chain.sessionUuid) ?? first;
    inTurn.set(turn, [...(inTurn.get(turn) ?? []), tallyOf(chain)]);
    if (turn !== null && shown.has(turn))
      chainTurns.push({ sessionUuid: chain.sessionUuid, turn });
  }
  chainTurns.sort(
    (a, b) =>
      a.turn - b.turn ||
      (a.sessionUuid < b.sessionUuid ? -1 : a.sessionUuid > b.sessionUuid ? 1 : 0),
  );
  const turns = rootTurns.map((t) => ({
    opening: {
      turn: t.index,
      seq: String(t.group.firstSeq),
      at: tachoTimestamp(t.group.firstAt),
    },
    sum: sumOf([tallyOf(t.group), ...(inTurn.get(t.index) ?? [])]),
  }));
  const beforeCost = sumOf([
    ...(before === undefined ? [] : [tallyOf(before)]),
    ...(inTurn.get(null) ?? []),
  ]).costMicros;
  return {
    turns: rowsOf(turns.slice(0, args.cap), beforeCost),
    complete: args.starts.length <= args.cap,
    chains: chainTurns.slice(0, args.cap),
  };
}
