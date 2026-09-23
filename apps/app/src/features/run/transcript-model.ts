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
import { type ToolDetail, toolDetail } from "./tool-detail";

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
 * The effect frames the recorder writes *about* a tool call: the command it
 * ran, the file it touched, the host it reached (tacho spec §6.1, stage
 * `effect`).
 *
 * These are not steps. They are the same action the tool frame beside them
 * already records, written again from the side of what it did to the machine,
 * and a `command` frame carries no body of its own in the common case. Drawn
 * as their own rows they doubled every Bash call in the transcript: one line
 * saying `Bash`, and a second saying `command` with "neither half of this
 * exchange was recorded" under it. Folded into the step they belong to, they
 * are what they always were — more evidence for the same step — and the
 * reader sees one line per thing the agent did. Nothing is dropped: every
 * folded frame is still in the step's `frames`, still drawn when the step is
 * opened, and still on the Frames tab.
 */
const EFFECT: ReadonlySet<string> = new Set(["command", "file_io", "network"]);

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
/**
 * The effect frames that belong to the tool step covering `indices`, appended
 * to it.
 *
 * A frame belongs when it carries the step's `callKey` — which is exact, and
 * survives two calls running at once — or, when neither side recorded a key,
 * when it sits immediately after the frames the step already owns. Adjacency
 * is the fallback and not the rule, so an effect frame that names a different
 * call is never folded into the wrong step; it stays its own row, which is
 * the honest reading of a record that says they are different things.
 */
function absorbEffects(
  frames: readonly TranscriptEntry[],
  indices: number[],
  callKey: string | null,
): number[] {
  const out = [...indices];
  let at = (out[out.length - 1] ?? 0) + 1;
  while (at < frames.length) {
    const next = frames[at];
    if (next === undefined || !EFFECT.has(next.type)) break;
    const sameCall = callKey !== null && next.callKey === callKey;
    const unkeyed = callKey === null && next.callKey === null;
    if (!sameCall && !unkeyed) break;
    out.push(at);
    at += 1;
  }
  return out;
}

/**
 * The positions of every frame that carries a `callKey`, by key, in transcript
 * order. Built once per `stepsOf` call so a keyed lookup (the close of a call,
 * the duplicate seals of one) reads the few frames of that call rather than
 * scanning forward through every frame after it.
 */
type ByCallKey = ReadonlyMap<string, readonly number[]>;

function indexByCallKey(frames: readonly TranscriptEntry[]): ByCallKey {
  const byKey = new Map<string, number[]>();
  frames.forEach((frame, index) => {
    if (frame.callKey === null) return;
    const positions = byKey.get(frame.callKey);
    if (positions === undefined) byKey.set(frame.callKey, [index]);
    else positions.push(index);
  });
  return byKey;
}

/** The first frame of `type` after `i` that carries `callKey`, or null. */
function closeOf(
  frames: readonly TranscriptEntry[],
  byKey: ByCallKey,
  i: number,
  callKey: string,
  type: string,
): number | null {
  for (const j of byKey.get(callKey) ?? []) {
    if (j <= i) continue;
    if (frames[j]?.type === type) return j;
  }
  return null;
}

function stepPair(
  frames: readonly TranscriptEntry[],
  byKey: ByCallKey,
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
      const j = closeOf(frames, byKey, i, callKey, close);
      return { indices: j === null ? [i] : [i, j], kind: "model" };
    }
    const paired = frames[i + 1]?.type === close;
    return { indices: paired ? [i, i + 1] : [i], kind: "model" };
  }
  if (frame.type === TOOL_REQUESTED || frame.type === TOOL_ENGINE_STARTED) {
    const close =
      frame.type === TOOL_ENGINE_STARTED ? TOOL_ENGINE_COMPLETED : TOOL_CALL;
    const callKey = frame.callKey;
    if (callKey !== null) {
      const j = closeOf(frames, byKey, i, callKey, close);
      return {
        indices: j === null ? [i] : absorbEffects(frames, [i, j], callKey),
        kind: "tool",
      };
    }
    const indices = [i];
    for (let j = i + 1; j < frames.length; j += 1) {
      const next = frames[j];
      if (next === undefined) break;
      if (next.type === close) {
        indices.push(j);
        return { indices: absorbEffects(frames, indices, null), kind: "tool" };
      }
      if (!TOOL_GATE.has(next.type)) break;
      indices.push(j);
    }
    return { indices, kind: "tool" };
  }
  if (frame.kind === "model_call") return { indices: [i], kind: "model" };
  if (frame.kind === "tool_call") {
    // A `tool_call` that opens its own step: the producer wrote no separate
    // request frame, so this one frame is the whole exchange. Its effect
    // frames still belong to it.
    return {
      indices: absorbEffects(frames, [i], frame.callKey),
      kind: "tool",
    };
  }
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
    const out = "stdout" in value ? value.stdout : undefined;
    const err = "stderr" in value ? value.stderr : undefined;
    const parts = [
      typeof out === "string" && out.length > 0 ? out : null,
      typeof err === "string" && err.length > 0 ? err : null,
    ].filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function stepsOf(
  frames: readonly TranscriptEntry[],
  offset: number,
): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  const claimed = new Set<number>();
  const byKey = indexByCallKey(frames);
  for (let i = 0; i < frames.length; i += 1) {
    if (claimed.has(i)) continue;
    const first = frames[i];
    if (first === undefined) continue;
    const { indices, kind } = stepPair(frames, byKey, i, first);
    // A wrapped session seals one tool call up to three times: once from the
    // PostToolUse hook, which carries the body, and once each from the OTel
    // log and the transcript tailer, which carry a digest and nothing else.
    // The three share the tool's call id. Read as three steps they drew the
    // page the way it looked: one call, then two "digest only" rows for it.
    // Folded on the call id, the call is one step, and `visibleFrames` keeps
    // the copy that has something to read.
    if (kind === "tool" && first.callKey !== null) {
      const last = indices[indices.length - 1] ?? i;
      for (const j of byKey.get(first.callKey) ?? []) {
        if (j <= last || claimed.has(j)) continue;
        if (frames[j]?.kind === "tool_call") indices.push(j);
      }
    }
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

/**
 * What a gate frame decided — `allow`, `deny`, `ask` — or null.
 *
 * The fold's own `decision` is authoritative and is read first; the label is
 * the fallback. A gate label leads with the decision and names the call it
 * was decided on after it (`deny Bash`), falling back to `policy deny` where
 * the row recorded no tool. So the decision is the label's FIRST word, not
 * its last, and a label that opens with the frame's own kind recorded no
 * decision at all.
 */
function policyOutcome(frame: TranscriptEntry): string | null {
  if (!TOOL_GATE.has(frame.type)) return null;
  if (frame.decision !== null) return frame.decision.decision;
  const words = frame.label.split(" ");
  const head = words[0] ?? "";
  if (head === frame.type) return null;
  if (head === "policy") return words[1] ?? null;
  return words.length > 1 ? head : null;
}

/** The call a gate frame decided on (`deny Bash` → `Bash`), or null. */
function policySubject(frame: TranscriptEntry): string | null {
  if (!TOOL_GATE.has(frame.type)) return null;
  const words = frame.label.split(" ");
  if (words.length < 2) return null;
  const head = words[0] ?? "";
  // `policy deny` names a decision and no call; every other two-word gate
  // label is `<decision-or-kind> <tool>`.
  if (head === "policy") return null;
  return words[1] ?? null;
}

/**
 * The call a frame's decision was made on, for the surface to name beside
 * the decision.
 *
 * A gate frame names the call in its label. A tool frame that carries a
 * folded decision *is* the call, so its own name is the subject. Anything
 * else answers null, and the surface says what was decided without claiming
 * a subject it does not have.
 */
export function decisionSubject(frame: TranscriptEntry): string | null {
  if (TOOL_GATE.has(frame.type)) return policySubject(frame);
  if (!TOOL_CLOSE.has(frame.type) && frame.type !== "tool_requested")
    return null;
  const name = toolName(frame.label);
  return name === frame.type ? null : name;
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
  // A gate step reads as the decision it made and the call it made it on.
  // `policy_decision` / `policy allow` named neither: the line said which
  // table the row came out of, which is the one thing a reader already knew.
  const subject = policySubject(first);
  if (node === "policy" || (node === "deny" && TOOL_GATE.has(first.type))) {
    return {
      node,
      name: outcome ?? first.type,
      arg: subject,
      // The name already is the decision, so the outcome chip would say it a
      // second time beside itself.
      outcome: null,
      status: null,
      durationMs,
      cost,
      repeats: null,
    };
  }
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

/**
 * What a tool step did, read from the body the recorder kept.
 *
 * The close frame is preferred because it holds both halves together
 * (`{input, output}`); the request frame holds the input alone and is the
 * fallback, which is what a step that never completed leaves behind. A step
 * whose bodies were all `digest_only` answers a detail with no panes: the
 * tool's name is still known from the frame's label, so the line still reads
 * even when there is nothing to show under it.
 *
 * Separate from `stepDigest` because it parses JSON, and the view calls it
 * behind a `useMemo` while it calls `stepDigest` on every render.
 */
export function stepTool(step: TranscriptStep): ToolDetail | null {
  if (step.kind !== "tool") return null;
  const close = step.frames.find((frame) => TOOL_CLOSE.has(frame.type));
  const named = close ?? step.first;
  const name = toolName(named.label);
  // A label of `Bash ok` names the tool; a label that is just the frame's
  // type names nothing, and the body's own `name` is then the only source.
  const known = name === named.type ? null : name;
  const ordered = close === undefined ? step.frames : [close, ...step.frames];
  const body =
    ordered
      .flatMap((frame) => [frame.response, frame.request])
      .find((half) => (half?.text ?? null) !== null)?.text ?? null;
  return toolDetail(known, body);
}

/**
 * What a model step did, read from the reply's blocks.
 *
 * A model call reads as the thing it did, not as the model that did it: a
 * reply that called Bash reads "Bash" with the command's first line, exactly
 * as the tool step for the same call would, through the same reader. A reply
 * with words and no call reads as a reply, with its first line. The model's
 * name moves to a chip. Null where no frame of the step kept its blocks, so
 * the view falls back to the digest.
 */
export function stepModel(step: TranscriptStep): ToolDetail | null {
  if (step.kind !== "model") return null;
  const blocks = step.frames
    .flatMap((frame) => [frame.response, frame.request])
    .find(
      (half) => half?.blocks !== undefined && half.blocks.length > 0,
    )?.blocks;
  if (blocks === undefined) return null;
  const uses = blocks.filter((block) => block.kind === "tool_use");
  if (uses.length > 0) {
    const details = uses.flatMap((use) => {
      const read = toolDetail(use.name, JSON.stringify({ input: use.input }));
      return read === null ? [] : [read];
    });
    const first = details[0];
    if (first !== undefined) {
      return {
        ...first,
        detail: uses.length > 1 ? `+${String(uses.length - 1)}` : first.detail,
        panes: details.flatMap((detail) => detail.panes),
      };
    }
  }
  const text = blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  if (text === "") return null;
  const cut = text.indexOf("\n");
  return {
    name: "reply",
    group: "tool",
    headline: cut === -1 ? text : text.slice(0, cut),
    detail: null,
    multiline: cut !== -1,
    panes: [{ kind: "note", label: "reply", text }],
  };
}

/**
 * The steps of a turn worth a row. A step with nothing to read on any frame
 * and no decision is bookkeeping (a hook registering, a queue tick) or a
 * digest-only duplicate of a call another source sealed with its body; the
 * Frames tab still has every one of them.
 */
export function visibleSteps(turn: TranscriptTurn): TranscriptStep[] {
  return turn.steps.filter((step) =>
    step.frames.some(
      (frame) =>
        hasContent(frame) ||
        frame.decision !== null ||
        TOOL_GATE.has(frame.type),
    ),
  );
}

/** Whether either half of the entry carries text to read. */
function hasContent(entry: TranscriptEntry): boolean {
  return [entry.request, entry.response].some(
    (half) => half !== null && half.text !== null,
  );
}

/**
 * The frames of a step worth drawing. A duplicate seal of the same tool call
 * that carries only a digest is left out when another frame of the step, for
 * the same call id, carries the body; a step whose every copy is digest-only
 * keeps them all, so a run recorded under `digest_only` still shows its
 * frames.
 */
export function visibleFrames(step: TranscriptStep): TranscriptEntry[] {
  if (step.kind !== "tool") return step.frames;
  const full = new Set(
    step.frames.flatMap((frame) =>
      frame.kind === "tool_call" && frame.callKey !== null && hasContent(frame)
        ? [frame.callKey]
        : [],
    ),
  );
  if (full.size === 0) return step.frames;
  return step.frames.filter(
    (frame) =>
      !(
        frame.kind === "tool_call" &&
        frame.callKey !== null &&
        full.has(frame.callKey) &&
        !hasContent(frame)
      ),
  );
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
