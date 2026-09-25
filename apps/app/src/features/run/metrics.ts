// The one derivation behind the Run page's figures (pages/run.md,
// Functionality: "One derivation feeds the stat row, the instruments, the Cost
// tab, and the Context tab, so no two panels can disagree"). The mockup's is
// `runMetrics` in engine.js, which seeds most of its numbers; this one reads
// every figure from the record the page already holds, and answers null for
// a figure the record does not carry, never a zero or a guess.
//
// What it reads:
//   - the run row: its cost and basis, when it started and sealed;
//   - the cost rollup (`get_run_cost`): the token classes, the cache hit rate,
//     the productive ratio, the per-model rows, and each model's recorded
//     cost by token class and cache saving; before the rollup reaches a
//     wrapped run, the per-model calls and reported cost ingest has folded
//     from its frames (`provisional`, #4032);
//   - the whole-run transcript at `everything`: prompts, steps, tool calls,
//     their families and batches, the wall clock split.
//
// The per-turn ledger is not derived here. The Cost tab reads it from
// `get_run_turns`, which counts every frame of the run where the frames are
// stored; `turnFigures` below only shapes those rows (#4067).
//
// It prices nothing. The rollup priced every frame from the price book at the
// frame's instant (ADR-060) and recorded the split; this sums what it recorded,
// so a rate change after the run cannot move a figure on the page (#4069).
//
// It is pure: the page reads, this derives, and the sections render.
import {
  byMicrosDescending,
  type Cost,
  type Money,
  sumMoney,
} from "@/data/contracts/money";
import type {
  CostByClass,
  RunCost,
  RunCostRollup,
  RunTranscript,
  RunTurn,
  TranscriptEntry,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { PriceTokenClass } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { groupOf, type ToolGroup } from "./tool-detail";
import {
  buildTranscript,
  flatSteps,
  isOperatorPrompt,
  stepDigest,
  type TranscriptStep,
  type TranscriptTurn,
} from "./transcript-model";
import { isWhole } from "./whole-transcript";

/** The six token classes of spec §12.6, in the order the Cost tab lists them. */
export const TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
] as const satisfies readonly PriceTokenClass[];
export type TokenClass = (typeof TOKEN_CLASSES)[number];

const INPUT_CLASSES: ReadonlySet<TokenClass> = new Set([
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
]);

/** A rollup figure per class (a count or a cost), by the class names the price book uses. */
function byTokenClass<T>(
  figures: Record<keyof CostByClass, T>,
): Record<TokenClass, T> {
  return {
    input_uncached: figures.inputUncached,
    cache_read: figures.cacheRead,
    cache_write_5m: figures.cacheWrite5m,
    cache_write_1h: figures.cacheWrite1h,
    output: figures.output,
    reasoning: figures.reasoning,
  };
}

export type TokenFigures = {
  /** Every class summed: the Tokens figure and the total row of Spend by token class. */
  total: number;
  /** The four input classes. */
  input: number;
  /** Output and reasoning. */
  output: number;
  byClass: Record<TokenClass, number>;
};

/**
 * The six classes' cost and what the cache saved against uncached input, as
 * the rollup recorded them per model, summed over the models.
 */
export type PricedClasses = {
  /** Null for a class a model spent tokens in without a recorded split. */
  byClass: Record<TokenClass, Money | null>;
  /**
   * Cache reads priced at the uncached input rate, less what they cost, as
   * recorded. Null when a model that read the cache has no recorded saving.
   */
  cacheSaved: Money | null;
  /**
   * The rollup could not price some call, so each figure here covers the
   * calls it did price and falls short of what the run spent.
   */
  hasUnpriced: boolean;
};

type Prompts = {
  /** The times the operator prompted the run: the first prompt and every one after it. */
  count: number;
  /** A prompt after the first fixes or fills what the first left out. */
  corrective: number;
};

/** Where the wall clock went; each part in milliseconds. */
type WallParts = {
  model: number;
  tool: number;
  /** From a parked call to the answer that released it. */
  waiting: number;
  /** What the model, the tools and the wait do not account for. */
  harness: number;
};
export type WallLead = keyof WallParts;

/** The wall clock's parts, in the order a tie is broken. */
const WALL_LEADS: readonly WallLead[] = ["model", "tool", "waiting", "harness"];

type WallClock = {
  /** Start to seal, or start to the last recorded frame on a live run; null when neither is recorded. */
  ms: number | null;
  sealed: boolean;
  /**
   * Oxagen closed the run for silence (`sealSource` `idle_timeout`, #3980):
   * the seal is when the close ran, 12 hours after the last event, and the
   * host never said the run ended, so there is no end to measure to. Every
   * reader of the clock, the stat row and the Cost tab's Wall clock alike,
   * reads it as not recorded.
   */
  closedIdle: boolean;
  /**
   * A live run's clock, which keeps counting after the render: the instant it
   * counts from (the run's start) and the instant `ms` was measured at, both
   * epoch milliseconds. Null for a run that has ended, and for a live run read
   * with no render instant, whose clock stops at its last frame.
   */
  ticking: { from: number; at: number } | null;
  parts: WallParts | null;
  lead: WallLead | null;
};

type ToolCall = {
  name: string;
  group: ToolGroup;
  /** The call's own wall time; null when the step is one frame. */
  ms: number | null;
  failed: boolean;
  /** The frame that opened the call, for its `fr N` link. */
  seq: string;
  /** The batch it ran in: the calls between two model steps. */
  batch: number;
};

export type Family = {
  group: ToolGroup;
  calls: number;
  /** Of every tool call in the run. */
  share: number;
  ms: number;
  failed: number;
  /** Distinct tool names in the family. */
  tools: number;
};

export type Batches = {
  count: number;
  /** Batches that ran more than one tool. */
  parallel: number;
  widest: number;
  fanOut: number;
  /** Sum of every call's own wall time: what one at a time would have taken. */
  serialMs: number;
  /** Sum of each batch's first start to its last end: what it did take. */
  togetherMs: number;
  /** How many batches asked for N tools, by N. */
  histogram: ReadonlyMap<number, number>;
};

export type TurnFigure = {
  /** 1-based, the number the transcript's entries carry for the same turn. */
  turn: number;
  steps: number;
  modelSteps: number;
  toolSteps: number;
  frames: number;
  cost: Money | null;
  /** cache_read ÷ (input_uncached + cache_read) over the turn's reported usage. */
  cacheHit: number | null;
  /** The frame the turn opens on. */
  seq: string;
};

export type RunMetrics = {
  /** The transcript was read to its end, so counts are totals rather than floors. */
  whole: boolean;
  tokens: TokenFigures | null;
  /**
   * The session's own sums over its `llm_call` frames, which stand in for the
   * Tokens figure until the rollup rebuilds the run, labelled provisional.
   * Null when the session reported none. They come in four kinds, not the
   * rollup's six classes, so they never price a class.
   */
  reportedTokens: { total: number; input: number; output: number } | null;
  priced: PricedClasses | null;
  /** The rollup's cost, else the run row's; the basis travels with it. */
  cost: Cost | null;
  /**
   * `cost` is a running estimate: the run is open, or the rollup was built
   * while it was (#3980). An open run's figure is an estimate whatever its
   * row says, since a row an idle close sealed reads final until rebuilt.
   */
  costIsEstimate: boolean;
  cacheHit: number | null;
  /**
   * The rollup's share of steps that advanced the task. No money figure is
   * derived from it: the contract does not say the ratio is weighted by cost,
   * so cost × (1 − ratio) would print a guess as "wasted" spend. The Wasted
   * figure reads not recorded until a contract carries it.
   */
  productiveRatio: number | null;
  prompts: Prompts | null;
  wall: WallClock;
  modelCalls: number | null;
  toolCalls: ToolCall[] | null;
  families: Family[] | null;
  batches: Batches | null;
  /** Entries the transcript files under the errors chip. */
  errors: number | null;
  /** Input tokens per model call, over the rollup's model calls. */
  perModelCall: number | null;
  /**
   * What each model cost as the session reported it, for a wrapped run the
   * rollup has not reached yet (#4032). Null once the rollup has a row for
   * the run, since the rollup's figures replace it, and when the read carried
   * none.
   */
  provisional: ProvisionalSpend | null;
};

/** One model's reported calls and cost, before the rollup prices them. */
export type ProvisionalModel = {
  model: string;
  provider: string | null;
  calls: number;
  /** Null when the session reported no cost for the model's calls. */
  cost: Cost | null;
};

export type ProvisionalSpend = {
  /** Dearest first; a model with no reported cost after every one with one. */
  byModel: ProvisionalModel[];
  /**
   * The reported costs summed. Null when no model reported one, or when they
   * are in more than one currency: a total across currencies is not a figure.
   */
  total: Money | null;
  /** Some model reported no cost, so `total` covers only the ones that did. */
  partial: boolean;
  toolCalls: number;
  /** The run's last recorded event, which these figures include. */
  asOf: string;
};

/** Order models by what they reported, dearest first, unpriced last. */
function byReportedCost(a: ProvisionalModel, b: ProvisionalModel): number {
  if (a.cost === null) return b.cost === null ? 0 : 1;
  if (b.cost === null) return -1;
  return byMicrosDescending(a.cost, b.cost);
}

/** `get_run_cost`'s provisional figures, summed; null when it carried none. */
function provisionalSpend(cost: Read<RunCost>): ProvisionalSpend | null {
  if (!cost.ok || cost.value.rollup !== null) return null;
  const provisional = cost.value.provisional ?? null;
  if (provisional === null) return null;
  const byModel = [...provisional.byModel].sort(byReportedCost);
  const priced = byModel.flatMap((row) =>
    row.cost === null ? [] : [row.cost],
  );
  return {
    byModel,
    total: sumMoney(priced),
    partial: priced.length < byModel.length,
    toolCalls: provisional.toolCalls,
    asOf: provisional.asOf,
  };
}

/**
 * The figure a cost reads when nothing metered the run: the agent's own
 * report on the run row, else the per-model costs the session reported, both
 * provisional. `floor` is set when some model reported no cost, so the sum
 * is a lower bound. The stat row and the Cost so far instrument both read
 * this, so the two print the same number.
 */
export function provisionalCost(
  run: RunRow,
  metrics: RunMetrics,
): { value: Money; floor: boolean } | null {
  if (metrics.cost !== null) return null;
  if (run.reportedCost != null)
    return { value: run.reportedCost, floor: false };
  const total = metrics.provisional?.total ?? null;
  return total === null
    ? null
    : { value: total, floor: metrics.provisional?.partial === true };
}

const APPROVAL_REQUEST = "approval_request";

function timeOf(entry: TranscriptEntry): number {
  return Date.parse(entry.at);
}

/** The ms from a step's first frame to its last, 0 for a one-frame step. */
function spanOf(step: TranscriptStep): number {
  return Math.max(0, timeOf(step.last) - timeOf(step.first));
}

/**
 * Each model's recorded cost by class and cache saving, summed. A recorded
 * split always counts, even for a class the model has no tokens in: the
 * rollup files an estimated frame's unsplit cost under `output`. A class is
 * summed only when every model that spent tokens in it has a recorded split,
 * so a partial sum is never shown as the class's cost. A model that read
 * nothing from the cache saved nothing, so it holds no saving back.
 */
function recordedClasses(rollup: RunCostRollup): PricedClasses | null {
  if (rollup.byModel.length === 0) return null;
  const classCost = (tokenClass: TokenClass): Money | null => {
    const parts: Money[] = [];
    for (const row of rollup.byModel) {
      if (row.costByClass !== null)
        parts.push(byTokenClass(row.costByClass)[tokenClass]);
      else if (byTokenClass(row.tokens)[tokenClass] > 0) return null;
    }
    return (
      sumMoney(parts) ??
      // A class nobody spent in costs nothing, in the rollup's currency.
      (rollup.cost === null
        ? null
        : { micros: "0", currency: rollup.cost.currency })
    );
  };
  const byClass: Record<TokenClass, Money | null> = {
    input_uncached: classCost("input_uncached"),
    cache_read: classCost("cache_read"),
    cache_write_5m: classCost("cache_write_5m"),
    cache_write_1h: classCost("cache_write_1h"),
    output: classCost("output"),
    reasoning: classCost("reasoning"),
  };
  const saved: Money[] = [];
  let savedKnown = true;
  for (const row of rollup.byModel) {
    if (row.tokens.cacheRead === 0) continue;
    if (row.cacheSaving === null) {
      savedKnown = false;
      break;
    }
    saved.push(row.cacheSaving);
  }
  return {
    byClass,
    cacheSaved: savedKnown ? sumMoney(saved) : null,
    hasUnpriced: rollup.byModel.some((row) => row.hasUnpriced),
  };
}

function tokenFigures(rollup: RunCostRollup): TokenFigures {
  const byClass = byTokenClass(rollup.tokens);
  let input = 0;
  let output = 0;
  for (const tokenClass of TOKEN_CLASSES) {
    if (INPUT_CLASSES.has(tokenClass)) input += byClass[tokenClass];
    else output += byClass[tokenClass];
  }
  return { total: input + output, input, output, byClass };
}

/**
 * The per-turn ledger from `get_run_turns`: what each turn cost, how many
 * steps and frames it took, and its cache hit, cache_read ÷ (input_uncached +
 * cache_read) over the input its model calls reported. A turn whose calls
 * reported no input has no cache hit, never a zero.
 */
export function turnFigures(turns: readonly RunTurn[]): TurnFigure[] {
  return turns.map((turn) => {
    const { inputUncached, cacheRead } = turn.tokens;
    const read = cacheRead ?? 0;
    const input = read + (inputUncached ?? 0);
    return {
      turn: turn.turn,
      steps: turn.modelSteps + turn.toolSteps,
      modelSteps: turn.modelSteps,
      toolSteps: turn.toolSteps,
      frames: turn.frames,
      cost: turn.cost,
      cacheHit:
        (inputUncached === null && cacheRead === null) || input === 0
          ? null
          : read / input,
      seq: turn.seq,
    };
  });
}

/**
 * The tool calls in step order, each with the batch it ran in. A batch is
 * the calls between two model steps: one model reply asks for them, and the
 * next model call reads their results.
 */
function toolCallsOf(
  turns: readonly TranscriptTurn[],
  waits: readonly Wait[],
): ToolCall[] {
  const calls: ToolCall[] = [];
  let batch = -1;
  let open = false;
  for (const turn of turns) {
    for (const step of flatSteps(turn)) {
      if (step.kind === "model") {
        open = false;
        continue;
      }
      if (step.kind !== "tool") continue;
      if (!open) {
        batch += 1;
        open = true;
      }
      const digest = stepDigest(step);
      calls.push({
        name: digest.name,
        group: groupOf(digest.name),
        ms:
          digest.durationMs === null
            ? null
            : Math.max(0, digest.durationMs - waitIn(step, waits)),
        failed: digest.node === "deny",
        seq: step.first.seq,
        batch,
      });
    }
    // A turn boundary closes the batch: the next turn opens on a prompt.
    open = false;
  }
  return calls;
}

function familiesOf(calls: readonly ToolCall[]): Family[] {
  const by = new Map<
    ToolGroup,
    { calls: number; ms: number; failed: number; names: Set<string> }
  >();
  for (const call of calls) {
    const family = by.get(call.group) ?? {
      calls: 0,
      ms: 0,
      failed: 0,
      names: new Set<string>(),
    };
    family.calls += 1;
    family.ms += call.ms ?? 0;
    if (call.failed) family.failed += 1;
    family.names.add(call.name);
    by.set(call.group, family);
  }
  return [...by.entries()]
    .map(([group, family]) => ({
      group,
      calls: family.calls,
      share: calls.length === 0 ? 0 : family.calls / calls.length,
      ms: family.ms,
      failed: family.failed,
      tools: family.names.size,
    }))
    .sort((a, b) => b.calls - a.calls || a.group.localeCompare(b.group));
}

function batchesOf(
  calls: readonly ToolCall[],
  turns: readonly TranscriptTurn[],
): Batches | null {
  if (calls.length === 0) return null;
  const steps = new Map<string, TranscriptStep>();
  for (const turn of turns)
    for (const step of flatSteps(turn)) steps.set(step.first.seq, step);
  const groups = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const group = groups.get(call.batch) ?? [];
    group.push(call);
    groups.set(call.batch, group);
  }
  const histogram = new Map<number, number>();
  let togetherMs = 0;
  let widest = 0;
  let parallel = 0;
  for (const group of groups.values()) {
    widest = Math.max(widest, group.length);
    if (group.length > 1) parallel += 1;
    histogram.set(group.length, (histogram.get(group.length) ?? 0) + 1);
    const spans = group
      .map((call) => steps.get(call.seq))
      .filter((step): step is TranscriptStep => step !== undefined);
    if (spans.length === 0) continue;
    const start = Math.min(...spans.map((step) => timeOf(step.first)));
    const end = Math.max(...spans.map((step) => timeOf(step.last)));
    togetherMs += Math.max(0, end - start);
  }
  return {
    count: groups.size,
    parallel,
    widest,
    fanOut: calls.length / groups.size,
    serialMs: calls.reduce((sum, call) => sum + (call.ms ?? 0), 0),
    togetherMs,
    histogram,
  };
}

/** One parked call: when it parked, and how long until the frame after it. */
type Wait = { at: number; ms: number };

/**
 * Each parked call's wait: from the approval request to the frame after it,
 * which is the time a person held the run.
 */
function waitsOf(entries: readonly TranscriptEntry[]): Wait[] {
  const waits: Wait[] = [];
  entries.forEach((entry, index) => {
    if (entry.type !== APPROVAL_REQUEST) return;
    const next = entries[index + 1];
    if (next !== undefined)
      waits.push({
        at: timeOf(entry),
        ms: Math.max(0, timeOf(next) - timeOf(entry)),
      });
  });
  return waits;
}

/**
 * The wait a step's span holds. A parked tool call's step runs from the
 * request to the result, so its span includes the time a person took to
 * answer; that time is the person's, not the tool's. The approval frame is a
 * step of its own, so the wait is found by where it falls, not by frame.
 */
function waitIn(step: TranscriptStep, waits: readonly Wait[]) {
  const from = timeOf(step.first);
  const to = timeOf(step.last);
  return waits.reduce(
    (sum, wait) => (wait.at >= from && wait.at < to ? sum + wait.ms : sum),
    0,
  );
}

function wallClock(
  run: RunRow,
  entries: readonly TranscriptEntry[] | null,
  turns: readonly TranscriptTurn[] | null,
  waits: readonly Wait[],
  now: number | null,
): WallClock {
  // The clock ends when the status says the run did: at the recorder's end
  // time, else the seal, which is the server's receipt time and can trail the
  // run by the upload. A live run is still running, so its clock runs to the
  // instant the page was rendered and keeps counting in the browser; read
  // with no such instant, it stops at the last recorded frame.
  const endedAt = run.status === "live" ? null : (run.endedAt ?? run.sealedAt);
  const sealed = endedAt !== null;
  if (run.status !== "live" && run.sealSource === "idle_timeout")
    return {
      ms: null,
      sealed,
      closedIdle: true,
      ticking: null,
      parts: null,
      lead: null,
    };
  const last = entries?.at(-1);
  const from = Date.parse(run.startedAt);
  const ticking =
    run.status === "live" && now !== null ? { from, at: now } : null;
  const ms = sealed
    ? Math.max(0, Date.parse(endedAt) - from)
    : ticking !== null
      ? Math.max(last?.elapsedMs ?? 0, ticking.at - from)
      : last === undefined
        ? null
        : last.elapsedMs;
  if (ms === null || entries === null || turns === null || ms === 0)
    return { ms, sealed, closedIdle: false, ticking, parts: null, lead: null };
  let model = 0;
  let tool = 0;
  for (const turn of turns) {
    for (const step of flatSteps(turn)) {
      if (step.kind === "model") model += spanOf(step);
      else if (step.kind === "tool")
        tool += Math.max(0, spanOf(step) - waitIn(step, waits));
    }
  }
  const waiting = waits.reduce((sum, wait) => sum + wait.ms, 0);
  const parts: WallParts = {
    model,
    tool,
    waiting,
    harness: Math.max(0, ms - model - tool - waiting),
  };
  const lead = WALL_LEADS.reduce((best, key) =>
    parts[key] > parts[best] ? key : best,
  );
  return {
    ms,
    sealed,
    closedIdle: false,
    ticking,
    parts,
    lead: parts[lead] > 0 ? lead : null,
  };
}

export function runMetrics({
  run,
  cost,
  transcript,
  now = null,
}: {
  run: RunRow;
  cost: Read<RunCost>;
  /** The whole-run transcript at `everything`. */
  transcript: Read<RunTranscript>;
  /**
   * The instant the page was rendered, in epoch milliseconds. A live run's
   * wall clock runs to it and keeps counting; without it, the clock stops at
   * the run's last recorded frame.
   */
  now?: number | null;
}): RunMetrics {
  const rollup = cost.ok ? cost.value.rollup : null;
  const entries = transcript.ok ? transcript.value.entries : null;
  const turns = entries === null ? null : buildTranscript(entries);
  const waits = entries === null ? [] : waitsOf(entries);
  const calls = turns === null ? null : toolCallsOf(turns, waits);
  const runCost = rollup?.cost ?? run.cost;
  const tokens = rollup === null ? null : tokenFigures(rollup);
  const reported = run.reportedTokens ?? null;
  const reportedTokens =
    reported === null
      ? null
      : {
          total:
            reported.input +
            reported.output +
            reported.cacheRead +
            reported.cacheWrite,
          input: reported.input + reported.cacheRead + reported.cacheWrite,
          output: reported.output,
        };
  const promptCount =
    entries === null ? null : entries.filter(isOperatorPrompt).length;
  return {
    whole: transcript.ok && isWhole(transcript.value),
    tokens,
    reportedTokens,
    priced: rollup === null ? null : recordedClasses(rollup),
    cost: runCost,
    costIsEstimate:
      run.sealedAt === null ||
      (rollup === null
        ? run.costIsEstimate === true
        : rollup.isEstimate === true),
    cacheHit: rollup?.cacheHitRate ?? null,
    productiveRatio: rollup?.productiveRatio ?? null,
    prompts:
      promptCount === null
        ? null
        : { count: promptCount, corrective: Math.max(0, promptCount - 1) },
    wall: wallClock(run, entries, turns, waits, now),
    modelCalls:
      rollup?.modelCalls ??
      (turns === null
        ? null
        : turns.reduce(
            (sum, turn) =>
              sum + flatSteps(turn).filter((s) => s.kind === "model").length,
            0,
          )),
    toolCalls: calls,
    families: calls === null ? null : familiesOf(calls),
    batches: calls === null || turns === null ? null : batchesOf(calls, turns),
    errors:
      entries === null
        ? null
        : entries.filter((entry) => entry.kinds.includes("errors")).length,
    perModelCall:
      rollup === null || tokens === null || rollup.modelCalls === 0
        ? null
        : Math.round(tokens.input / rollup.modelCalls),
    provisional: provisionalSpend(cost),
  };
}
