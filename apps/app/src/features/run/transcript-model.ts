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
 * is what the frame renderer does.
 */
export function soleBody(entry: TranscriptEntry): TranscriptBody | null {
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
const TOOL_REQUESTED = "tool_requested";
const TOOL_CALL = "tool_call";
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

/** Where the step opening at `i` ends (exclusive), and what kind it is. */
function stepEnd(
  frames: readonly TranscriptEntry[],
  i: number,
  frame: TranscriptEntry,
): { end: number; kind: TranscriptStep["kind"] } {
  if (frame.type === MODEL_REQUEST) {
    const paired = frames[i + 1]?.type === MODEL_RESPONSE;
    return { end: paired ? i + 2 : i + 1, kind: "model" };
  }
  if (frame.type === TOOL_REQUESTED) {
    let end = i + 1;
    for (let next = frames[end]; next !== undefined; next = frames[end]) {
      if (next.type === TOOL_CALL) return { end: end + 1, kind: "tool" };
      if (!TOOL_GATE.has(next.type)) break;
      end += 1;
    }
    return { end, kind: "tool" };
  }
  if (frame.kind === "model_call") return { end: i + 1, kind: "model" };
  if (frame.kind === "tool_call") return { end: i + 1, kind: "tool" };
  return { end: i + 1, kind: "event" };
}

function stepsOf(
  frames: readonly TranscriptEntry[],
  offset: number,
): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  let i = 0;
  for (let first = frames[i]; first !== undefined; first = frames[i]) {
    const { end, kind } = stepEnd(frames, i, first);
    const slice = frames.slice(i, end);
    steps.push({
      id: `s${first.seq}`,
      kind,
      from: offset + i,
      to: offset + end - 1,
      first,
      last: slice[slice.length - 1] ?? first,
      frames: slice,
    });
    i = end;
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
    };
  }
  if (step.kind === "tool") {
    // The call's own frame carries the outcome; the request only names the tool.
    const named =
      step.frames.find((frame) => frame.type === TOOL_CALL) ?? first;
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
