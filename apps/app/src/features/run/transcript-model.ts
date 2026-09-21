// The transcript's shape (mockup `pRun`, "Transcript: run -> turn -> step ->
// frame"): the entries `get_run_transcript` answers at `everything`, one per
// frame, grouped into the turns they fall in and the steps inside each turn.
//
// Pure, so the grouping is tested without a render. Nothing here reads a body
// or invents a value: a step's name, argument and chips come from the frames'
// recorded types, labels, instants and costs, and a figure the frames did not
// carry is left out rather than drawn as a zero.
import { type Money, sumMoney } from "@/data/contracts/money";
import type { TranscriptBody, TranscriptEntry } from "@/data/contracts/run";

/**
 * The one half of the exchange an entry carries, or null.
 *
 * At `everything` an entry is a single frame, so exactly one half is recorded:
 * what went out, or what came back. This answers that half.
 *
 * An entry carrying BOTH halves answers null rather than picking one. That is
 * the whole point of the function. The contract folds a step at the `steps`
 * and `turns` zooms, and a folded tool step carries its input in `request` and
 * its result in `response`; a positional `response ?? request` would silently
 * render a tool's input where its result belongs, and nothing about the page
 * would look wrong. A caller that needs both halves reads them by name, which
 * is what the frame renderer does. Module-private: its one caller is
 * `textOf` below, in this file; a turn's prompt and reply are the only
 * place the app still reads a body positionally instead of by name.
 */
function soleBody(entry: TranscriptEntry): TranscriptBody | null {
  if (entry.request !== null && entry.response !== null) return null;
  return entry.response ?? entry.request;
}

/** A transcript with at least one frame: the only kind the view draws. */
export type Frames = readonly [TranscriptEntry, ...TranscriptEntry[]];

export function isNonEmpty(
  entries: readonly TranscriptEntry[],
): entries is Frames {
  return entries.length > 0;
}

/** The frame at `pos`, held inside the transcript. */
export function frameAt(entries: Frames, pos: number): TranscriptEntry {
  const index = Math.min(Math.max(0, pos), entries.length - 1);
  return entries[index] ?? entries[0];
}

/** The spine's dot: what kind of thing a step was. */
export type StepNode = "model" | "tool" | "policy" | "control" | "deny";

export type TranscriptStep = {
  /** Stable across re-reads of a live run: the opening frame's seq. */
  id: string;
  kind: "model" | "tool" | "event";
  /** Positions of the step's first and last frames in the transcript. */
  from: number;
  to: number;
  first: TranscriptEntry;
  last: TranscriptEntry;
  frames: TranscriptEntry[];
};

export type TranscriptTurn = {
  id: string;
  /** Null for the frames recorded before the run's first turn. */
  turn: number | null;
  first: TranscriptEntry;
  last: TranscriptEntry;
  frames: TranscriptEntry[];
  steps: TranscriptStep[];
  /** The prompt the turn opened with, when the recorder kept its body. */
  prompt: string | null;
  /** The agent's last message in the turn, when the recorder kept its body. */
  reply: string | null;
};

const MODEL_REQUEST = "model.request";
const MODEL_RESPONSE = "model.response";
/** The in-app assistant's write-ahead and receipt for a model call. */
const MODEL_ENGINE_STARTED = "model.engine_call_started";
const MODEL_ENGINE_COMPLETED = "model.engine_call_completed";
const TOOL_REQUESTED = "tool_requested";
const TOOL_CALL = "tool_call";
/** The in-app assistant's write-ahead and receipt for a tool call. */
const TOOL_ENGINE_STARTED = "tool.engine_call_started";
const TOOL_ENGINE_COMPLETED = "tool.engine_call_completed";
/** The frame that closes a tool step: wrapped `tool_call` or engine receipt. */
const TOOL_CLOSE: ReadonlySet<string> = new Set([
  TOOL_CALL,
  TOOL_ENGINE_COMPLETED,
]);
/** Policy frames: the decision about a tool call, which sits between its request and the call. */
const TOOL_GATE: ReadonlySet<string> = new Set([
  "policy_decision",
  "approval_request",
  "approval_decision",
  "token_issued",
  "token_use",
  "token_denied",
  "tool.approval_recorded",
]);
const CONTROL: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_stop",
  "subagent_start",
  "subagent_stop",
  "turn_start",
  "turn_end",
]);

/**
 * Which indices the step opening at `i` owns, and what kind it is.
 *
 * A model or tool exchange is two frames wherever the producer wrote two: the
 * request and the response. The wrapped session spells those
 * `model.request`/`model.response` and `tool_requested`/`tool_call`; the
 * in-app assistant spells them `*.engine_call_started`/`*.engine_call_completed`.
 * Both halves carry the same step kind at `everything`, so without this pair
 * each half would draw as its own step.
 *
 * When the opening frame carries a `callKey`, the close is the later frame of
 * the matching close type with the same key, even when another call's start or
 * close sits between them (TOOL_GATE frames are allowed through the same way).
 * Frames claimed by an earlier pair are skipped by `stepsOf`, so overlapping
 * `start A, start B, complete A, complete B` yields two steps that each own
 * their own halves. When `callKey` is null, pairing stays adjacency: the next
 * close of the right type, with only TOOL_GATE frames allowed between a tool's
 * request and its call.
 */
function stepPair(
  frames: readonly TranscriptEntry[],
  i: number,
  frame: TranscriptEntry,
): { indices: number[]; kind: TranscriptStep["kind"] } {
  if (frame.type === MODEL_REQUEST || frame.type === MODEL_ENGINE_STARTED) {
    const close =
      frame.type === MODEL_ENGINE_STARTED
        ? MODEL_ENGINE_COMPLETED
        : MODEL_RESPONSE;
    const callKey = frame.callKey;
    if (callKey !== null) {
      for (let j = i + 1; j < frames.length; j += 1) {
        const next = frames[j];
        if (next === undefined) break;
        if (next.type === close && next.callKey === callKey) {
          return { indices: [i, j], kind: "model" };
        }
      }
      return { indices: [i], kind: "model" };
    }
    const paired = frames[i + 1]?.type === close;
    return { indices: paired ? [i, i + 1] : [i], kind: "model" };
  }
  if (frame.type === TOOL_REQUESTED || frame.type === TOOL_ENGINE_STARTED) {
    const close =
      frame.type === TOOL_ENGINE_STARTED ? TOOL_ENGINE_COMPLETED : TOOL_CALL;
    const callKey = frame.callKey;
    if (callKey !== null) {
      for (let j = i + 1; j < frames.length; j += 1) {
        const next = frames[j];
        if (next === undefined) break;
        if (next.type === close && next.callKey === callKey) {
          return { indices: [i, j], kind: "tool" };
        }
      }
      return { indices: [i], kind: "tool" };
    }
    const indices = [i];
    for (let j = i + 1; j < frames.length; j += 1) {
      const next = frames[j];
      if (next === undefined) break;
      if (next.type === close) {
        indices.push(j);
        return { indices, kind: "tool" };
      }
      if (!TOOL_GATE.has(next.type)) break;
      indices.push(j);
    }
    return { indices, kind: "tool" };
  }
  if (frame.kind === "model_call") return { indices: [i], kind: "model" };
  if (frame.kind === "tool_call") return { indices: [i], kind: "tool" };
  // A run of the same bookkeeping frame is one step with a count, not one row
  // per frame. Claude Code registers thirty-odd hooks at a session's start and
  // the recorder writes an `oxagen:hook_health` frame for each, so a run
  // opened with thirty identical rows before anything a person did.
  if (isBare(frame)) {
    const indices = [i];
    for (let j = i + 1; j < frames.length; j += 1) {
      const next = frames[j];
      if (next === undefined || next.type !== frame.type || !isBare(next))
        break;
      indices.push(j);
    }
    return { indices, kind: "event" };
  }
  return { indices: [i], kind: "event" };
}

/** A frame with nothing to read on it: no half, no decision. */
function isBare(frame: TranscriptEntry): boolean {
  return (
    frame.kind === "frame" &&
    frame.request === null &&
    frame.response === null &&
    frame.decision === null
  );
}

/**
 * A wrapped session's tool receipt carries the call's input and its output in
 * one JSON body. Read them apart so the page can label each, and null for a
 * body that is not that shape. A shell result is shown as its streams rather
 * than as the JSON around them.
 */
export function toolExchange(
  text: string,
): { input: string; output: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("input" in parsed) || !("output" in parsed)) return null;
  const { input, output } = parsed;
  return { input: readable(input), output: readable(output) };
}

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const streams = value as Record<string, unknown>;
    const out = streams["stdout"];
    const err = streams["stderr"];
    const parts = [
      typeof out === "string" && out.length > 0 ? out : null,
      typeof err === "string" && err.length > 0 ? err : null,
    ].filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join("\n");
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

function stepsOf(
  frames: readonly TranscriptEntry[],
  offset: number,
): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  const claimed = new Set<number>();
  for (let i = 0; i < frames.length; i += 1) {
    if (claimed.has(i)) continue;
    const first = frames[i];
    if (first === undefined) continue;
    const { indices, kind } = stepPair(frames, i, first);
    for (const index of indices) {
      if (index !== i) claimed.add(index);
    }
    const slice = indices.flatMap((index) => {
      const entry = frames[index];
      return entry === undefined ? [] : [entry];
    });
    const last = slice[slice.length - 1] ?? first;
    const from = indices[0] ?? i;
    const to = indices[indices.length - 1] ?? i;
    steps.push({
      id: `s${first.seq}`,
      kind,
      from: offset + from,
      to: offset + to,
      first,
      last,
      frames: slice,
    });
  }
  return steps;
}

/** The first (or last) frame of `type` in `frames` that carries text. */
function textOf(
  frames: readonly TranscriptEntry[],
  type: string,
  last: boolean,
): string | null {
  const ordered = last ? [...frames].reverse() : frames;
  const found = ordered.find(
    (frame) => frame.type === type && (soleBody(frame)?.text ?? null) !== null,
  );
  return found === undefined ? null : (soleBody(found)?.text ?? null);
}

/**
 * The run as turns. Entries are grouped by their `turn`; a run of entries
 * with the same value is one group, so a recording that reuses a turn number
 * after a gap still reads in the order it happened.
 */
export function buildTranscript(
  entries: readonly TranscriptEntry[],
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let start = 0;
  entries.forEach((entry, index) => {
    const next = entries[index + 1];
    if (next !== undefined && next.turn === entry.turn) return;
    const frames = entries.slice(start, index + 1);
    const first = frames[0] ?? entry;
    turns.push({
      id: `t${first.seq}`,
      turn: entry.turn,
      first,
      last: entry,
      frames,
      steps: stepsOf(frames, start),
      prompt: textOf(frames, "turn_start", false),
      reply: textOf(frames, "turn_end", true),
    });
    start = index + 1;
  });
  return turns;
}

function toolName(label: string): string {
  return label.split(" ")[0] ?? label;
}

/** The status word a tool frame's label ends with (`Read ok`), or null. */
function toolStatus(label: string): string | null {
  const [, status] = label.split(" ");
  return status ?? null;
}

/** The outcome a policy frame recorded (`policy deny` → `deny`), or null. */
function policyOutcome(frame: TranscriptEntry): string | null {
  if (!TOOL_GATE.has(frame.type)) return null;
  const words = frame.label.split(" ");
  return words.length > 1 ? (words[words.length - 1] ?? null) : null;
}

const DENIED = /^(deny|denied|reject|rejected|refused)$/;
const FAILED = /^(error|failed|failure|denied|timeout)$/;

export type StepDigest = {
  node: StepNode;
  name: string;
  /** What the step acted on; null when the label says nothing beyond the name. */
  arg: string | null;
  /** The policy outcome a tool step recorded, when one did. */
  outcome: string | null;
  /** The tool's recorded status, when one did. */
  status: string | null;
  /** The step's wall time in ms; null for a one-frame step. */
  durationMs: number | null;
  cost: Money | null;
  /** How many identical frames this event step folds; null unless more than one. */
  repeats: number | null;
};

export function stepDigest(step: TranscriptStep): StepDigest {
  const { first, last } = step;
  const durationMs =
    step.frames.length > 1 ? Date.parse(last.at) - Date.parse(first.at) : null;
  const cost = frameCost(step.frames);
  if (step.kind === "model") {
    const model = first.label.split("/").pop() ?? first.label;
    return {
      node: "model",
      name: model,
      arg: model === first.label ? null : first.label,
      outcome: null,
      status: null,
      durationMs,
      cost,
      repeats: null,
    };
  }
  if (step.kind === "tool") {
    // The call's own frame carries the outcome; the request only names the tool.
    const named =
      step.frames.find((frame) => TOOL_CLOSE.has(frame.type)) ?? first;
    const gate = step.frames.map(policyOutcome).find((o) => o !== null) ?? null;
    const status = toolStatus(named.label);
    const denied =
      (gate !== null && DENIED.test(gate)) ||
      (status !== null && FAILED.test(status));
    const name = toolName(named.label);
    return {
      node: denied ? "deny" : "tool",
      name,
      arg: first.label === name ? null : first.label,
      outcome: gate,
      status,
      durationMs,
      cost,
      repeats: null,
    };
  }
  const outcome = policyOutcome(first);
  const control =
    CONTROL.has(first.type) ||
    first.type.startsWith("oxagen:") ||
    first.type.startsWith("admission.");
  let node: StepNode = "tool";
  if (outcome !== null && DENIED.test(outcome)) node = "deny";
  else if (TOOL_GATE.has(first.type)) node = "policy";
  else if (control) node = "control";
  return {
    node,
    name: first.type,
    arg: first.label === first.type ? null : first.label,
    outcome,
    status: null,
    durationMs,
    cost,
    repeats: step.frames.length > 1 ? step.frames.length : null,
  };
}

/** The frames' cost records summed; null when none carried one. */
export function frameCost(frames: readonly TranscriptEntry[]): Money | null {
  return sumMoney(
    frames.flatMap((frame) => (frame.cost === null ? [] : [frame.cost])),
  );
}

/**
 * How long playback waits before moving from `pos` to the next frame: the
 * real gap, held between 120 ms and 2 s so idle time is compressed and a
 * burst stays readable, divided by the speed.
 */
export function playDelay(
  entries: readonly TranscriptEntry[],
  pos: number,
  speed: number,
): number {
  const here = entries[pos];
  const next = entries[pos + 1];
  if (here === undefined || next === undefined) return 400;
  const gap = Date.parse(next.at) - Date.parse(here.at);
  return Math.min(2000, Math.max(120, gap)) / speed;
}

/** The ids open at a zoom level: turns open at Steps, turns and steps at Everything. */
export function openAtZoom(
  turns: readonly TranscriptTurn[],
  zoom: "turns" | "steps" | "everything",
): Set<string> {
  const open = new Set<string>();
  if (zoom === "turns") return open;
  for (const turn of turns) {
    open.add(turn.id);
    if (zoom === "everything") for (const step of turn.steps) open.add(step.id);
  }
  return open;
}

/** The turn and step holding position `pos`, so a reveal opens both. */
export function idsAt(turns: readonly TranscriptTurn[], pos: number): string[] {
  for (const turn of turns) {
    const step = turn.steps.find((s) => pos >= s.from && pos <= s.to);
    if (step !== undefined) return [turn.id, step.id];
  }
  return [];
}
