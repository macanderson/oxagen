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
//     the productive ratio, the per-model rows;
//   - the whole-run transcript at `everything`: prompts, steps, tool calls,
//     their families and batches, the per-turn ledger, the wall clock split;
//   - the organization's price book, to price the token classes and the
//     cache's saving, both labelled as priced from the book.
//
// It is pure: the page reads, this derives, and the sections render.
import {
  type Cost,
  type Money,
  priceTokens,
  shareOfMicros,
  subMoney,
  sumMoney,
} from "@/data/contracts/money";
import type {
  RunCost,
  RunCostRollup,
  RunTranscript,
  TranscriptEntry,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { PriceBook, PriceTokenClass } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { groupOf, type ToolGroup } from "./tool-detail";
import {
  buildTranscript,
  frameCost,
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

/** The rollup's counts, by the class names the price book uses. */
function classCounts(
  tokens: RunCostRollup["tokens"],
): Record<TokenClass, number> {
  return {
    input_uncached: tokens.inputUncached,
    cache_read: tokens.cacheRead,
    cache_write_5m: tokens.cacheWrite5m,
    cache_write_1h: tokens.cacheWrite1h,
    output: tokens.output,
    reasoning: tokens.reasoning,
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

/** The six classes priced from the book, and what the cache saved against uncached input. */
export type PricedClasses = {
  /** Null for a class no book row prices for every model the run used. */
  byClass: Record<TokenClass, Money | null>;
  /** Cache reads priced at the uncached input rate, less what they cost. */
  cacheSaved: Money | null;
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
  /** 1-based; null for the frames before the first turn. */
  turn: number | null;
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
  /** The share of the cost the rollup did not count as productive. */
  wasted: Cost | null;
  cacheHit: number | null;
  productiveRatio: number | null;
  prompts: Prompts | null;
  wall: WallClock;
  turns: TurnFigure[] | null;
  modelCalls: number | null;
  toolCalls: ToolCall[] | null;
  families: Family[] | null;
  batches: Batches | null;
  /** Entries the transcript files under the errors chip. */
  errors: number | null;
  /** Input tokens per model call, over the rollup's model calls. */
  perModelCall: number | null;
};

const APPROVAL_REQUEST = "approval_request";

function timeOf(entry: TranscriptEntry): number {
  return Date.parse(entry.at);
}

/** The ms from a step's first frame to its last, 0 for a one-frame step. */
function spanOf(step: TranscriptStep): number {
  return Math.max(0, timeOf(step.last) - timeOf(step.first));
}

function priceOf(
  book: PriceBook | null,
  model: string,
  tokenClass: TokenClass,
): Money | null {
  if (book === null) return null;
  const row = book.entries.find(
    (entry) =>
      entry.tokenClass === tokenClass &&
      entry.unit === "token" &&
      entry.region === null &&
      (entry.model === model || entry.modelAliases.includes(model)),
  );
  return row?.ratePerMillion ?? null;
}

/**
 * The classes priced per model from the book and summed. A class is priced
 * only when every model that spent tokens in it has a row, so a partial sum
 * is never shown as the class's cost.
 */
function priceClasses(
  rollup: RunCostRollup,
  book: PriceBook | null,
): PricedClasses | null {
  if (book === null || rollup.byModel.length === 0) return null;
  const classPrice = (tokenClass: TokenClass): Money | null => {
    const parts: Money[] = [];
    let unpriced = false;
    for (const row of rollup.byModel) {
      const count = classCounts(row.tokens)[tokenClass];
      if (count === 0) continue;
      const rate = priceOf(book, row.model, tokenClass);
      if (rate === null) {
        unpriced = true;
        break;
      }
      parts.push(priceTokens(rate, count));
    }
    return unpriced
      ? null
      : (sumMoney(parts) ??
          // A class nobody spent in costs nothing, in the rollup's currency.
          (rollup.cost === null
            ? null
            : { micros: "0", currency: rollup.cost.currency }));
  };
  const byClass: Record<TokenClass, Money | null> = {
    input_uncached: classPrice("input_uncached"),
    cache_read: classPrice("cache_read"),
    cache_write_5m: classPrice("cache_write_5m"),
    cache_write_1h: classPrice("cache_write_1h"),
    output: classPrice("output"),
    reasoning: classPrice("reasoning"),
  };
  const saved: Money[] = [];
  let savedKnown = true;
  for (const row of rollup.byModel) {
    if (row.tokens.cacheRead === 0) continue;
    const fresh = priceOf(book, row.model, "input_uncached");
    const cached = priceOf(book, row.model, "cache_read");
    const diff =
      fresh === null || cached === null
        ? null
        : subMoney(
            priceTokens(fresh, row.tokens.cacheRead),
            priceTokens(cached, row.tokens.cacheRead),
          );
    if (diff === null) {
      savedKnown = false;
      break;
    }
    saved.push(diff);
  }
  return {
    byClass,
    cacheSaved: savedKnown ? sumMoney(saved) : null,
  };
}

function tokenFigures(rollup: RunCostRollup): TokenFigures {
  const byClass = classCounts(rollup.tokens);
  let input = 0;
  let output = 0;
  for (const tokenClass of TOKEN_CLASSES) {
    if (INPUT_CLASSES.has(tokenClass)) input += byClass[tokenClass];
    else output += byClass[tokenClass];
  }
  return { total: input + output, input, output, byClass };
}

function wasted(cost: Cost | null, ratio: number | null): Cost | null {
  if (cost === null || ratio === null) return null;
  const part = shareOfMicros(cost, 1 - ratio);
  return part === null ? null : { ...part, basis: cost.basis };
}

/** The per-turn ledger: what each turn cost, how many steps it took, and its cache hit. */
function turnFigures(turns: readonly TranscriptTurn[]): TurnFigure[] {
  return turns
    .filter((turn) => turn.turn !== null)
    .map((turn) => {
      let read = 0;
      let fresh = 0;
      let reported = false;
      for (const frame of turn.frames) {
        const usage = frame.usage;
        if (usage === null || usage === undefined) continue;
        if (usage.cacheRead !== null) {
          read += usage.cacheRead;
          reported = true;
        }
        if (usage.inputUncached !== null) {
          fresh += usage.inputUncached;
          reported = true;
        }
      }
      const modelSteps = turn.steps.filter((s) => s.kind === "model").length;
      const toolSteps = turn.steps.filter((s) => s.kind === "tool").length;
      return {
        turn: turn.turn,
        steps: modelSteps + toolSteps,
        modelSteps,
        toolSteps,
        frames: turn.frames.reduce((sum, frame) => sum + frame.frames, 0),
        cost: frameCost(turn.frames),
        cacheHit: reported && read + fresh > 0 ? read / (read + fresh) : null,
        seq: turn.first.seq,
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
    for (const step of turn.steps) {
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
    for (const step of turn.steps) steps.set(step.first.seq, step);
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
): WallClock {
  // The clock ends when the status says the run did: at the recorder's end
  // time, else the seal, which is the server's receipt time and can trail the
  // run by the upload. A live run runs to its last recorded frame.
  const endedAt = run.status === "live" ? null : (run.endedAt ?? run.sealedAt);
  const sealed = endedAt !== null;
  const last = entries?.at(-1);
  const ms = sealed
    ? Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt))
    : last === undefined
      ? null
      : last.elapsedMs;
  if (ms === null || entries === null || turns === null || ms === 0)
    return { ms, sealed, parts: null, lead: null };
  let model = 0;
  let tool = 0;
  for (const turn of turns) {
    for (const step of turn.steps) {
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
  return { ms, sealed, parts, lead: parts[lead] > 0 ? lead : null };
}

export function runMetrics({
  run,
  cost,
  transcript,
  book,
}: {
  run: RunRow;
  cost: Read<RunCost>;
  /** The whole-run transcript at `everything`. */
  transcript: Read<RunTranscript>;
  /** The organization's price book; null when it was not read or was refused. */
  book: PriceBook | null;
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
    priced: rollup === null ? null : priceClasses(rollup, book),
    cost: runCost,
    wasted: wasted(runCost, rollup?.productiveRatio ?? null),
    cacheHit: rollup?.cacheHitRate ?? null,
    productiveRatio: rollup?.productiveRatio ?? null,
    prompts:
      promptCount === null
        ? null
        : { count: promptCount, corrective: Math.max(0, promptCount - 1) },
    wall: wallClock(run, entries, turns, waits),
    turns: turns === null ? null : turnFigures(turns),
    modelCalls:
      rollup?.modelCalls ??
      (turns === null
        ? null
        : turns.reduce(
            (sum, turn) =>
              sum + turn.steps.filter((s) => s.kind === "model").length,
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
  };
}
