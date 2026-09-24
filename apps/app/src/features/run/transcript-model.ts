// The transcript's shape. Two readings of the entries `get_run_transcript`
// answers at `everything`, one per frame:
//
//  - `buildTranscript`: the frames grouped into the turns they fall in and the
//    steps inside each turn, which the Run page's metrics count from;
//  - `buildFeed`: the rows the Transcript tab draws (mockup `txEntries` and
//    `txRow`): the operator's prompt, the model's text and thinking, each tool
//    call as one row, what each model step cost, what was recalled, and the
//    run's stop.
//
// Pure, so both are tested without a render. Nothing here invents a value: a
// row's name, arguments and chips come from the frames' recorded types,
// labels, instants, bodies and costs, and a figure the frames did not carry
// is left out rather than drawn as a zero.
import { type Cost, type Money, sumMoney } from "@/data/contracts/money";
import type {
  TranscriptBody,
  TranscriptEntry,
  TranscriptUsage,
} from "@/data/contracts/run";
import {
  parseBody,
  type ToolDetail,
  type ToolDiff,
  type ToolGroup,
  toolDetailOf,
} from "./tool-detail";

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
 * is what the tool reading does. Module-private: the feed reads a prompt,
 * a reply and a recall frame through it, which are single-frame entries.
 */
function soleBody(entry: TranscriptEntry): TranscriptBody | null {
  if (entry.request !== null && entry.response !== null) return null;
  return entry.response ?? entry.request;
}

/**
 * An entry's name within its run. A subagent records on a chain of its own,
 * numbered from 0 like the run's, so its entries are named by chain and seq
 * together; an entry on the run's own chain is named by its seq, as before.
 * Stable across re-reads, so it keys a rendered list and a step's id.
 */
export function entryKey(entry: TranscriptEntry): string {
  return entry.subagent === undefined
    ? entry.seq
    : `${entry.subagent.chainRef}:${entry.seq}`;
}

/** A transcript with at least one frame: the only kind the view draws. */
export type Frames = readonly [TranscriptEntry, ...TranscriptEntry[]];

export function isNonEmpty(
  entries: readonly TranscriptEntry[],
): entries is Frames {
  return entries.length > 0;
}

/**
 * `page` merged into `held` by each entry's opening frame (`entryKey`): an
 * entry the reader already holds is replaced where it stands, and a new one
 * is appended in the order the page sent it.
 *
 * `get_run_transcript` sends an entry again when it has grown since it was
 * sent: a step that gained its result, a turn that gained a step, a Task call
 * whose subagent recorded more (#4048). The grown copy is the one to show,
 * and appending it drew the same step twice. Replacing in place keeps the
 * row where the reader saw it, and keeps the last entry the run's latest.
 */
export function mergeEntries(
  held: Frames,
  page: readonly TranscriptEntry[],
): Frames;
export function mergeEntries(
  held: readonly TranscriptEntry[],
  page: readonly TranscriptEntry[],
): TranscriptEntry[];
export function mergeEntries(
  held: readonly TranscriptEntry[],
  page: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  const out = [...held];
  const at = new Map(out.map((entry, index) => [entryKey(entry), index]));
  for (const entry of page) {
    const key = entryKey(entry);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, out.length);
      out.push(entry);
    } else out[index] = entry;
  }
  return out;
}

/** The spine's dot: what kind of thing a step was. */
type StepNode = "model" | "tool" | "policy" | "control" | "deny";

export type TranscriptStep = {
  /** Stable across re-reads of a live run: the opening frame's `entryKey`. */
  id: string;
  kind: "model" | "tool" | "event";
  /** Positions of the step's first and last frames in the transcript. */
  from: number;
  to: number;
  first: TranscriptEntry;
  last: TranscriptEntry;
  frames: TranscriptEntry[];
  /**
   * The steps of the subagents this step spawned, in the order recorded. Set
   * on the Task or Agent call that started them (`nestSubagents`); absent on
   * every other step.
   */
  children?: TranscriptStep[];
};

export type TranscriptTurn = {
  id: string;
  /** Null for the frames recorded before the run's first turn. */
  turn: number | null;
  first: TranscriptEntry;
  last: TranscriptEntry;
  frames: TranscriptEntry[];
  steps: TranscriptStep[];
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
  // The steering the agent was shown at its start, sealed beside it.
  "steering.manifest",
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
 * The harness's own permission check on a tool call (Claude Code's
 * `tool_decision`). It runs on every call whether or not anyone was asked, so
 * it is evidence about the call and never Oxagen's verdict: an allow folds into
 * the call's step and draws nothing of its own, and only a refusal shows.
 */
const HARNESS: ReadonlySet<string> = new Set(["harness_permission"]);

/** Whether a harness check refused the call (`deny Bash`). */
function harnessDenied(frame: TranscriptEntry): boolean {
  if (!HARNESS.has(frame.type)) return false;
  return DENIED.test(frame.label.split(" ")[0] ?? "");
}

/** The chain an entry was recorded on: a subagent's, or "" for the run's own. */
function chainOf(entry: TranscriptEntry): string {
  return entry.subagent?.chainRef ?? "";
}

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
      // The decisions about this call, keyed to it, belong to it as they do
      // when the pairing is by adjacency: a policy decision or an approval
      // request between the request and the call, or after a request that
      // has no call yet because it is waiting on one.
      const gates = (byKey.get(callKey) ?? []).filter(
        (k) =>
          k > i &&
          (j === null || k < j) &&
          TOOL_GATE.has(frames[k]?.type ?? ""),
      );
      return {
        indices:
          j === null
            ? [i, ...gates]
            : absorbEffects(frames, [i, ...gates, j], callKey),
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
      if (
        next === undefined ||
        next.type !== frame.type ||
        next.callKey !== frame.callKey ||
        !isBare(next)
      )
        break;
      // A subagent's frame of the same type is the subagent's: the run's
      // own stop is not folded into a subagent's, nor the other way round.
      if (next.subagent?.chainRef !== frame.subagent?.chainRef) break;
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
 * Every frame of one tool call, gathered on its call key, or null when the
 * frame at `i` does not open one.
 *
 * A wrapped Claude Code session writes up to six frames for one call, all
 * carrying the call's `tool_use_id`: Oxagen's gate decision, the PreToolUse
 * request, the harness's own permission check, the PostToolUse receipt with
 * the body, and digest-only copies from the OTel log and the transcript
 * tailer. They are not adjacent. Oxagen's decision lands before the request,
 * and a parallel call's frames fall between them. Paired by adjacency they
 * drew as a column of "allow Bash" rows with the call nowhere in sight.
 * Gathered on the key, the call is one step whose first frame is the earliest
 * one recorded, and `visibleFrames` keeps the copies worth reading.
 *
 * A key counts as a call only when some frame with it on the same chain is a
 * tool frame. A gate on a call whose tool frames were never recorded stays its
 * own step, so the decision still reads.
 */
function callFold(
  frames: readonly TranscriptEntry[],
  byKey: ByCallKey,
  claimed: ReadonlySet<number>,
  i: number,
  first: TranscriptEntry,
): { indices: number[]; kind: TranscriptStep["kind"] } | null {
  const key = first.callKey;
  if (key === null || first.kind === "model_call") return null;
  const chain = chainOf(first);
  const indices = (byKey.get(key) ?? []).filter((j) => {
    const frame = frames[j];
    return (
      frame !== undefined &&
      j >= i &&
      !claimed.has(j) &&
      frame.kind !== "model_call" &&
      chainOf(frame) === chain
    );
  });
  if (!indices.some((j) => frames[j]?.kind === "tool_call")) return null;
  return { indices: absorbEffects(frames, indices, key), kind: "tool" };
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
    const { indices, kind } =
      callFold(frames, byKey, claimed, i, first) ??
      stepPair(frames, byKey, i, first);
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
      id: `s${entryKey(first)}`,
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
      id: `t${entryKey(first)}`,
      turn: entry.turn,
      first,
      last: entry,
      frames,
      steps: nestSubagents(stepsOf(frames, start)),
    });
    start = index + 1;
  });
  return turns;
}

/**
 * The steps with each subagent's steps moved under the call that spawned it.
 *
 * A subagent records on a chain of its own, and the reader splices that chain
 * in where it began, so its steps sit between the Task call's first and last
 * frames. Drawn flat they read as the parent's own work. Each subagent step
 * goes under the step whose call key is the subagent's `spawnKey`, or, for a
 * recording that kept none, under the nearest earlier step that holds a
 * `subagent_start`. A subagent step with neither stays where it was.
 */
function nestSubagents(steps: TranscriptStep[]): TranscriptStep[] {
  const out: TranscriptStep[] = [];
  const owner = new Map<string, TranscriptStep>();
  let spawner: TranscriptStep | null = null;
  const own = (step: TranscriptStep, parent: TranscriptStep): void => {
    for (const frame of step.frames)
      if (frame.callKey !== null && !owner.has(frame.callKey))
        owner.set(frame.callKey, parent);
  };
  for (const step of steps) {
    const sub = step.first.subagent;
    const parent =
      sub === undefined
        ? undefined
        : ((sub.spawnKey == null ? undefined : owner.get(sub.spawnKey)) ??
          spawner ??
          undefined);
    if (parent === undefined) {
      out.push(step);
      own(step, step);
      if (sub === undefined && step.frames.some(isSpawn)) spawner = step;
      continue;
    }
    parent.children = [...(parent.children ?? []), step];
    own(step, parent);
  }
  return out;
}

function isSpawn(frame: TranscriptEntry): boolean {
  return frame.type === "subagent_start";
}

/**
 * A turn's steps with each subagent step back in the place it was recorded,
 * for a reader that counts or times steps rather than draws them: the Run
 * page's metrics count a subagent's calls as the run's calls, as they did
 * before the Transcript tab nested them under their Task call.
 */
export function flatSteps(turn: TranscriptTurn): TranscriptStep[] {
  const all: TranscriptStep[] = [];
  const add = (steps: readonly TranscriptStep[]): void => {
    for (const step of steps) {
      all.push(step);
      add(step.children ?? []);
    }
  };
  add(turn.steps);
  return all.sort((a, b) => a.from - b.from);
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
 * The call a frame's decision was made on, for the Policy tab to name beside
 * the decision.
 *
 * A gate frame names the call in its label. A tool call entry, or a tool
 * frame that carries a folded decision, *is* the call, so its own name is the
 * subject. Anything
 * else answers null, and the surface says what was decided without claiming
 * a subject it does not have.
 */
export function decisionSubject(frame: TranscriptEntry): string | null {
  if (TOOL_GATE.has(frame.type)) return policySubject(frame);
  const call =
    frame.kind === "tool_call" ||
    TOOL_CLOSE.has(frame.type) ||
    frame.type === "tool_requested";
  if (!call) return null;
  const name = toolName(frame.label);
  return name === frame.type ? null : name;
}

const DENIED = /^(deny|denied|reject|rejected|refused)$/;
const FAILED = /^(error|failed|failure|denied|timeout)$/;

type StepDigest = {
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
    // The call's own frame carries the outcome; the request only names the
    // tool. A step gathered on its call key can open on the gate's decision,
    // whose label (`allow Bash`) names the decision first, so the name and
    // the argument come from the call's frames and never from the gate's.
    const call =
      step.frames.find((frame) => frame.kind === "tool_call") ?? first;
    const named =
      step.frames.find((frame) => TOOL_CLOSE.has(frame.type)) ?? call;
    const gate = step.frames.map(policyOutcome).find((o) => o !== null) ?? null;
    const status = toolStatus(named.label);
    const denied =
      (gate !== null && DENIED.test(gate)) ||
      (status !== null && FAILED.test(status)) ||
      step.frames.some(harnessDenied);
    const name = toolName(named.label);
    return {
      node: denied ? "deny" : "tool",
      name,
      arg: stepTarget(step) ?? (call.label === name ? null : call.label),
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

/** The frame that closes a tool step: its result, or the one receipt a producer wrote. */
function toolClose(step: TranscriptStep): TranscriptEntry | undefined {
  const close = step.frames.find((frame) => TOOL_CLOSE.has(frame.type));
  if (close !== undefined) return close;
  // A receipt with no request frame before it is the whole exchange; an
  // intention is only the request. A step gathered on its call key opens on
  // the gate's decision when Oxagen decided first (`callFold`), so the
  // receipt is looked for among every frame, not only the first.
  return step.frames.find(
    (frame) =>
      frame.kind === "tool_call" &&
      frame.type !== TOOL_REQUESTED &&
      frame.type !== TOOL_ENGINE_STARTED,
  );
}

/**
 * What a tool step did, read from the bodies the recorder kept.
 *
 * A wrapped session's receipt holds both halves together (`{input, output}`),
 * and is read as it is. A producer that wrote the input on the request frame
 * and the result on the receipt is read from both: the input from the one,
 * the output from the other. A step whose bodies were all `digest_only`
 * still answers a detail when its label names the tool, so the row still
 * reads even when there is nothing to show under it.
 *
 * Separate from `stepDigest` because it parses JSON.
 *
 * @internal Exported for its unit test; the feed is its caller.
 */
export function stepTool(step: TranscriptStep): ToolDetail | null {
  if (step.kind !== "tool") return null;
  const close = toolClose(step);
  // A step gathered on its call key can open on the gate's decision, whose
  // label (`allow Bash`) names the decision first, so the name comes from the
  // call's own frames and never from the gate's.
  const named =
    close ??
    step.frames.find((frame) => frame.kind === "tool_call") ??
    step.first;
  const name = toolName(named.label);
  // A label of `Bash ok` names the tool; a label that is just the frame's
  // type names nothing, and the body's own `name` is then the only source.
  const known = name === named.type ? null : name;
  // The receipt that kept a body. A wrapped call is sealed up to three times
  // on one call key, and the copies that kept only a digest are passed over.
  const receipt =
    step.frames.find(
      (frame) =>
        (frame === close || frame.kind === "tool_call") &&
        frame.type !== TOOL_REQUESTED &&
        frame.type !== TOOL_ENGINE_STARTED &&
        (frame.response?.text ?? null) !== null,
    ) ?? close;
  const receiptText = receipt?.response?.text ?? null;
  const parsed = parseBody(receiptText);
  if (isExchange(parsed)) return toolDetailOf(known, parsed);
  // The input is the first request half that kept text.
  const requested = parseBody(
    step.frames
      .map((frame) => frame.request)
      .find((half) => (half?.text ?? null) !== null)?.text ?? null,
  );
  const output = parsed ?? receiptText;
  if (isRecord(requested) && isRecord(requested["tool_use"]))
    return toolDetailOf(known, { ...requested, tool_result: output });
  if (isExchange(requested))
    return toolDetailOf(known, { ...requested, output });
  const detail = toolDetailOf(known, { input: requested, output });
  const target = stepTarget(step);
  if (detail === null || requested !== null || target === null) return detail;
  // No input was kept, but the gate recorded what the call acted on. That is
  // the command or path the reader came for, so it is drawn as the input.
  const cut = target.indexOf("\n");
  return {
    ...detail,
    headline: detail.headline ?? (cut === -1 ? target : target.slice(0, cut)),
    multiline: detail.headline === null ? cut !== -1 : detail.multiline,
    raw: detail.raw ?? target,
  };
}

/** What the step's call acted on, as its gate recorded it; null when none did. */
function stepTarget(step: TranscriptStep): string | null {
  for (const frame of step.frames) {
    if (frame.target != null && frame.target !== "") return frame.target;
  }
  return null;
}

/** A body in one of the call shapes `splitBody` reads, rather than a bare input or output. */
function isExchange(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    ("input" in value || "output" in value || "tool_use" in value)
  );
}

/**
 * The frames' cost records summed; null when none carried one.
 *
 * @internal Exported for its unit test. `stepDigest` is its production
 * caller; the Cost tab's per-turn cost comes from `get_run_turns` since #4067.
 */
export function frameCost(frames: readonly TranscriptEntry[]): Money | null {
  return sumMoney(
    frames.flatMap((frame) => (frame.cost === null ? [] : [frame.cost])),
  );
}

// ── The feed ────────────────────────────────────────────────────────────────

/**
 * The Transcript tab's kind chips (mockup `TX_GROUPS`), each over something
 * the record carries:
 *
 *  - `prompt`: the operator's words, a `turn_start` frame's body on the
 *    run's own chain;
 *  - `responses`: the model's text, from the reply's `text` blocks or a plain
 *    reply body, and the message a turn closed on;
 *  - `thinking`: the reply's `thinking` blocks;
 *  - `tools`: one row per tool call, a tool step or a `tool_use` block no
 *    tool step recorded;
 *  - `usage`: one row per model step that carried a cost record or token
 *    counts;
 *  - `recall`: the frames the contract files under `recall` (what was put in
 *    front of the model: `context.*`, `steering.manifest`);
 *  - `seal`: the run's own stop frames, `agent_stop` and the ledger's
 *    `terminal.attempt_terminated`.
 *
 * The contract's `policy` kind has no chip of its own: a decision is drawn as
 * the ⚖ chip on the call it was made about, which is where the design puts it.
 */
export const FEED_GROUPS = [
  "prompt",
  "responses",
  "thinking",
  "tools",
  "usage",
  "recall",
  "seal",
] as const;
export type FeedGroup = (typeof FEED_GROUPS)[number];

/** A frame a row links to. `chainRef` is set for a subagent's frame, which no link can open by seq. */
export type FrameRef = { seq: string; type: string; chainRef: string | null };

/** A decision a rule or a person made about a call, and the frame that records it. */
export type FeedGate = { decision: string; frame: FrameRef };

export type FeedCall = {
  name: string;
  group: ToolGroup;
  /** What the call acted on, on one line; null when the record says nothing more than the name. */
  arg: string | null;
  /** First frame of the call to its last; null for a call recorded in one frame. */
  durationMs: number | null;
  output: string | null;
  diffs: ToolDiff[];
  /** The call as it was made, for the row's fold. */
  raw: string | null;
  gates: FeedGate[];
  /** The request for approval the call is waiting on, when it is. */
  parked: FrameRef | null;
  /** No frame recorded a result, and nothing refused or parked the call. */
  pending: boolean;
  /** A body of the call was cut at the contract's ceiling. */
  truncated: boolean;
  /** The call's own frame: its receipt, or its request when none was written. */
  frame: FrameRef;
};

type FeedRecall = {
  /** What the count counts: context frames, or the items a manifest included. */
  unit: "frames" | "items";
  count: number | null;
  tokens: number | null;
  cut: number | null;
  items: { kind: string; label: string; tokens: number | null }[];
};

type FeedBase = {
  key: string;
  /** The instant of the frame the row reads, and how far into the run it sits. */
  at: string;
  elapsedMs: number;
  /** The chip that shows or hides the row; null for a row no chip governs. */
  group: FeedGroup | null;
  /** A call that did not do what it was asked to, or a frame that recorded an error. */
  failed: boolean;
  subagent: TranscriptEntry["subagent"];
  /**
   * The key of the Task or Agent call row a subagent's row sits under, so the
   * view draws the subagent's work inside the call that spawned it; null for
   * a row of the run's own.
   */
  parent: string | null;
  /** What the run had spent by this row: the contract's own running total. */
  spent: Cost | null;
  /** The row's words, lowercased, for the search field. */
  haystack: string;
};

export type FeedRow = FeedBase &
  (
    | { kind: "prompt"; text: string; turn: number | null; first: boolean }
    | { kind: "text"; text: string }
    | {
        kind: "thinking";
        /**
         * The thought as the reply kept it; null when the harness recorded
         * that the model thought (`tokens`) and kept none of the words.
         */
        text: string | null;
        /** The reasoning tokens behind a thought no words were kept for; null otherwise. */
        tokens: number | null;
      }
    | { kind: "tool"; call: FeedCall }
    | {
        kind: "usage";
        model: string | null;
        usage: TranscriptUsage | null;
        cost: Cost | null;
        /** The reasoning effort the call ran at, as the harness recorded it; null when unrecorded. */
        effort: string | null;
        frame: FrameRef;
      }
    | { kind: "recall"; recall: FeedRecall; frame: FrameRef }
    | { kind: "seal"; label: string | null; frame: FrameRef }
    | {
        kind: "event";
        name: string;
        text: string | null;
        gates: FeedGate[];
        frame: FrameRef;
      }
  );

const MESSAGE = "oxagen:message";
const SEAL: ReadonlySet<string> = new Set([
  "agent_stop",
  "terminal.attempt_terminated",
]);
/** A decision that holds the call until someone answers it. */
const ASK = /^(ask|approve|approval|approval_required|pending|parked)$/;
const ANSWER: ReadonlySet<string> = new Set([
  "approval_decision",
  "tool.approval_recorded",
  "token_denied",
]);

function refOf(frame: TranscriptEntry): FrameRef {
  return {
    seq: frame.seq,
    type: frame.type,
    chainRef: frame.subagent?.chainRef ?? null,
  };
}

function haystack(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

function base(
  key: string,
  frame: TranscriptEntry,
  group: FeedGroup | null,
  spent: Cost | null,
): Omit<FeedBase, "haystack"> {
  return {
    key,
    at: frame.at,
    elapsedMs: frame.elapsedMs,
    group,
    failed: false,
    subagent: frame.subagent,
    parent: null,
    spent,
  };
}

/** The text of the one half a single-frame entry carries, when it kept any. */
function soleText(frames: readonly TranscriptEntry[]): string | null {
  for (const frame of frames) {
    const text = soleBody(frame)?.text ?? null;
    if (text !== null && text.trim() !== "") return text;
  }
  return null;
}

/** The decisions recorded on a step's frames, one per deciding frame. */
function gatesOf(frames: readonly TranscriptEntry[]): FeedGate[] {
  const seen = new Set<string>();
  const gates: FeedGate[] = [];
  for (const frame of frames) {
    const gate: FeedGate | null =
      frame.decision !== null
        ? {
            decision: frame.decision.decision,
            frame: {
              seq: frame.decision.seq,
              type: frame.decision.type,
              chainRef: frame.decision.chainRef ?? null,
            },
          }
        : TOOL_GATE.has(frame.type)
          ? {
              decision: policyOutcome(frame) ?? frame.type,
              frame: refOf(frame),
            }
          : null;
    if (gate === null) continue;
    const key = `${gate.frame.chainRef ?? ""}:${gate.frame.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gates.push(gate);
  }
  return gates;
}

/** The step's cost records summed, with the basis they share; null when none carried one. */
function stepCost(frames: readonly TranscriptEntry[]): Cost | null {
  const costs = frames.flatMap((frame) =>
    frame.cost === null ? [] : [frame.cost],
  );
  const sum = sumMoney(costs);
  if (sum === null) return null;
  const bases = new Set(costs.map((cost) => cost.basis));
  const [basis] = bases;
  // Two observers of one step's cost is no single basis, and the row says so
  // rather than lending the figure the stronger of the two.
  return { ...sum, basis: bases.size === 1 ? (basis ?? null) : null };
}

/** The step's token counts summed, class by class; null when no frame reported any. */
function stepUsage(frames: readonly TranscriptEntry[]): TranscriptUsage | null {
  const reported = frames.flatMap((frame) =>
    frame.usage === null || frame.usage === undefined ? [] : [frame.usage],
  );
  if (reported.length === 0) return null;
  const sum = (key: keyof TranscriptUsage): number | null => {
    const counts = reported.flatMap((usage) =>
      usage[key] === null ? [] : [usage[key]],
    );
    return counts.length === 0 ? null : counts.reduce((a, b) => a + b, 0);
  };
  return {
    inputUncached: sum("inputUncached"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    reasoning: sum("reasoning"),
  };
}

type Block = NonNullable<TranscriptBody["blocks"]>[number];
type ToolUse = Extract<Block, { kind: "tool_use" }>;
type ToolResults = ReadonlyMap<string, { ok: boolean; summary: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "string" ? found : null;
}

/** One part of a Messages API `content` array as a block, or none. */
function contentBlock(part: unknown): Block[] {
  const type = textField(part, "type");
  if (type === "text") {
    const said = textField(part, "text");
    return said === null ? [] : [{ kind: "text", text: said }];
  }
  if (type === "thinking") {
    const thought = textField(part, "thinking");
    return thought === null ? [] : [{ kind: "thinking", text: thought }];
  }
  const name = textField(part, "name");
  if (type !== "tool_use" || name === null || name === "") return [];
  return [
    {
      kind: "tool_use",
      name,
      input: isRecord(part) ? part["input"] : null,
      callKey: textField(part, "id"),
    },
  ];
}

/** A chat completion's first message as blocks: its reasoning, its words, its calls. */
function messageBlocks(message: Record<string, unknown>): Block[] {
  const blocks: Block[] = [];
  const reasoning = textField(message, "reasoning_content");
  if (reasoning !== null && reasoning !== "")
    blocks.push({ kind: "thinking", text: reasoning });
  const said = textField(message, "content");
  if (said !== null && said !== "") blocks.push({ kind: "text", text: said });
  const calls = message["tool_calls"];
  for (const call of Array.isArray(calls) ? calls : []) {
    const fn = isRecord(call) ? call["function"] : null;
    const name = textField(fn, "name");
    if (name === null || name === "") continue;
    const args = textField(fn, "arguments");
    blocks.push({
      kind: "tool_use",
      name,
      input: parseBody(args) ?? args,
      callKey: textField(call, "id"),
    });
  }
  return blocks;
}

/**
 * A reply body the recorder kept as the provider's own JSON, read as blocks:
 * the Messages API's `content` array, or a chat completion's first message.
 * Null for any other shape, and the reply is then drawn by its cost alone,
 * never as JSON to open.
 */
function providerBlocks(text: string | null): Block[] | null {
  const parsed = parseBody(text);
  if (!isRecord(parsed)) return null;
  const content = parsed["content"];
  const choices = parsed["choices"];
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(choice) ? choice["message"] : undefined;
  const blocks = Array.isArray(content)
    ? content.flatMap(contentBlock)
    : isRecord(message)
      ? messageBlocks(message)
      : [];
  return blocks.length === 0 ? null : blocks;
}

/** The reply's blocks: as the recorder assembled them, or read from the provider's JSON. */
function replyBlocks(step: TranscriptStep): Block[] | null {
  const halves = step.frames.flatMap((frame) => [
    frame.response,
    frame.request,
  ]);
  const assembled = halves.find(
    (half) => half?.blocks !== undefined && half.blocks.length > 0,
  )?.blocks;
  if (assembled !== undefined) return assembled;
  for (const frame of step.frames) {
    const read = providerBlocks(frame.response?.text ?? null);
    if (read !== null) return read;
  }
  return null;
}

/** A reply the recorder kept as plain words: not JSON, so not a body to open. */
function replyText(step: TranscriptStep): string | null {
  for (const frame of step.frames) {
    const text = frame.response?.text ?? null;
    if (text === null || text.trim() === "") continue;
    if (parseBody(text) !== null) continue;
    return text;
  }
  return null;
}

/** The results a reply's `tool_result` blocks record, by the call they answer. */
function toolResults(entries: readonly TranscriptEntry[]): ToolResults {
  const results = new Map<string, { ok: boolean; summary: string }>();
  for (const entry of entries) {
    for (const half of [entry.request, entry.response]) {
      for (const block of half?.blocks ?? []) {
        if (block.kind === "tool_result")
          results.set(block.forRef, { ok: block.ok, summary: block.summary });
      }
    }
  }
  return results;
}

/** The headline and its qualifier on one line, or null when neither was recorded. */
function argOf(detail: ToolDetail | null): string | null {
  const parts = [detail?.headline ?? null, detail?.detail ?? null].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

function toolRow(step: TranscriptStep): FeedRow {
  const digest = stepDigest(step);
  const detail = stepTool(step);
  const close = toolClose(step);
  const answered = step.frames.some(
    (frame) =>
      ANSWER.has(frame.type) ||
      (frame.decision !== null && !ASK.test(frame.decision.decision)),
  );
  const asked =
    step.frames.find((frame) => frame.type === "approval_request") ??
    step.frames.find(
      (frame) =>
        TOOL_GATE.has(frame.type) && ASK.test(policyOutcome(frame) ?? ""),
    );
  const parked =
    asked !== undefined && close === undefined && !answered
      ? refOf(asked)
      : null;
  const failed =
    digest.node === "deny" ||
    step.frames.some((frame) => frame.kinds.includes("errors"));
  const name = detail?.name ?? digest.name;
  const arg = detail === null ? digest.arg : argOf(detail);
  const call: FeedCall = {
    name,
    group: detail?.group ?? "tool",
    arg,
    // A call with no result has taken no time yet that the record can
    // state: the gap to its last gate frame is a wait, not the call.
    durationMs: close === undefined ? null : digest.durationMs,
    output: detail?.output ?? null,
    diffs: detail?.diffs ?? [],
    raw: detail?.raw ?? null,
    gates: gatesOf(step.frames),
    parked,
    pending: close === undefined && parked === null && !failed,
    truncated: step.frames.some(
      (frame) =>
        frame.request?.truncated === true || frame.response?.truncated === true,
    ),
    // The call's own frame: its receipt, or its request while it has none.
    // Never the gate's, which a step gathered on the call key can open on.
    frame: refOf(
      close ??
        step.frames.find((frame) => frame.kind === "tool_call") ??
        step.first,
    ),
  };
  return {
    ...base(step.id, step.first, "tools", step.last.cumulativeCost),
    failed,
    kind: "tool",
    call,
    haystack: haystack([
      name,
      arg,
      call.raw,
      call.output,
      ...call.diffs.flatMap((diff) =>
        diff.diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)),
      ),
    ]),
  };
}

/**
 * A tool the model called that no tool step recorded: the gateway saw the
 * call in the reply, and the harness wrote no frame of its own for it. Its
 * result is the reply's `tool_result` block for the same call, when one was
 * kept.
 */
function blockToolRow(
  block: ToolUse,
  key: string,
  frame: TranscriptEntry,
  results: ToolResults,
): FeedRow {
  const result =
    block.callKey === null ? undefined : results.get(block.callKey);
  const detail = toolDetailOf(block.name, {
    input: block.input,
    output: result?.summary ?? null,
  });
  const name = detail?.name ?? block.name;
  const arg = argOf(detail);
  const call: FeedCall = {
    name,
    group: detail?.group ?? "tool",
    arg,
    durationMs: null,
    output: detail?.output ?? null,
    diffs: detail?.diffs ?? [],
    raw: detail?.raw ?? null,
    gates: [],
    parked: null,
    pending: result === undefined,
    truncated: frame.response?.truncated === true,
    frame: refOf(frame),
  };
  return {
    ...base(key, frame, "tools", frame.cumulativeCost),
    failed: result?.ok === false,
    kind: "tool",
    call,
    haystack: haystack([name, arg, call.raw, call.output]),
  };
}

/**
 * The rows a model step reads as: what it thought, what it said, what it
 * cost, then any tool it called that no tool step recorded. A reply whose
 * only content is a call that a tool step recorded reads as that tool's row
 * alone, so no row is ever a model frame with JSON to open.
 */
function modelRows(
  step: TranscriptStep,
  claims: (block: ToolUse) => boolean,
  results: ToolResults,
): FeedRow[] {
  const reply =
    [...step.frames].reverse().find((frame) => frame.response !== null) ??
    step.last;
  const spent = step.last.cumulativeCost;
  const blocks = replyBlocks(step);
  const rows: FeedRow[] = [];
  const said = (key: string, kind: "text" | "thinking", text: string) => {
    const at = base(
      key,
      reply,
      kind === "text" ? "responses" : "thinking",
      spent,
    );
    rows.push(
      kind === "text"
        ? { ...at, kind, text, haystack: haystack([text]) }
        : { ...at, kind, text, tokens: null, haystack: haystack([text]) },
    );
  };
  if (blocks === null) {
    const text = replyText(step);
    if (text !== null) said(`${step.id}:text`, "text", text);
  } else {
    blocks.forEach((block, index) => {
      if (block.kind !== "text" && block.kind !== "thinking") return;
      if (block.text.trim() === "") return;
      said(`${step.id}:${String(index)}`, block.kind, block.text);
    });
  }
  const cost = stepCost(step.frames);
  const usage = stepUsage(step.frames);
  // A harness that reports reasoning tokens and keeps none of the thought
  // (Claude Code over OTel) still says the model thought, and how much.
  const thought = rows.some((row) => row.kind === "thinking");
  const reasoning = usage?.reasoning ?? null;
  if (!thought && reasoning !== null && reasoning > 0) {
    rows.push({
      ...base(`${step.id}:thinking`, reply, "thinking", spent),
      kind: "thinking",
      text: null,
      tokens: reasoning,
      haystack: "",
    });
  }
  const effort =
    step.frames.find((frame) => frame.effort != null && frame.effort !== "")
      ?.effort ?? null;
  if (cost !== null || usage !== null || effort !== null) {
    const model = stepDigest(step).name;
    rows.push({
      ...base(`${step.id}:usage`, reply, "usage", spent),
      kind: "usage",
      model: model === reply.type ? null : model,
      usage,
      cost,
      effort,
      frame: refOf(reply),
      haystack: haystack([model, effort]),
    });
  }
  blocks?.forEach((block, index) => {
    if (block.kind !== "tool_use" || claims(block)) return;
    rows.push(
      blockToolRow(block, `${step.id}:u${String(index)}`, reply, results),
    );
  });
  return rows;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One listed item of a recall body: its kind, what it is, and its tokens. */
function recallItem(
  item: Record<string, unknown>,
): FeedRecall["items"][number] {
  return {
    kind: textField(item, "kind") ?? textField(item, "type") ?? "",
    label:
      textField(item, "label") ??
      textField(item, "id") ??
      textField(item, "name") ??
      "",
    tokens: numberField(item["tokens"]) ?? numberField(item["tok"]),
  };
}

/**
 * What a recall frame says it put in front of the model. A steering manifest
 * (ADR-093) lists its items with the outcome of each; a context frame lists
 * its frames; the ledger's `context.frames_selected` carries only a count, in
 * its label.
 */
function recallOf(step: TranscriptStep): FeedRecall {
  const parsed = parseBody(soleText(step.frames));
  if (isRecord(parsed)) {
    const items = parsed["items"];
    const list = Array.isArray(items) ? items : parsed["frames"];
    if (Array.isArray(list)) {
      // A manifest lists what it cut beside what it kept; the row lists what
      // reached the model and counts the rest.
      const kept = list
        .filter(isRecord)
        .filter(
          (item) =>
            item["outcome"] === undefined || item["outcome"] === "included",
        )
        .map(recallItem);
      return {
        unit: Array.isArray(items) ? "items" : "frames",
        count: numberField(parsed["included"]) ?? kept.length,
        tokens:
          numberField(parsed["spent_tokens"]) ?? numberField(parsed["tokens"]),
        cut: numberField(parsed["cut"]),
        items: kept,
      };
    }
  }
  const counted = /^frames=(\d+)$/.exec(step.first.label)?.[1];
  return {
    unit: "frames",
    count: counted === undefined ? null : Number(counted),
    tokens: null,
    cut: null,
    items: [],
  };
}

/**
 * Whether a frame records the operator prompting the run: a `turn_start` on
 * the run's own chain. A subagent's turn opens on the words its parent sent,
 * which the parent's tool call already shows. The contract's `prompt` kind is
 * something else, the request half of a model call, so it is not read here.
 * The feed's prompt rows and the stat row's Prompts figure both read this.
 */
export function isOperatorPrompt(frame: TranscriptEntry): boolean {
  return frame.type === "turn_start" && frame.subagent === undefined;
}

/** Frame types that frame the run rather than record what it did: no row unless they failed or were decided on. */
function isQuiet(type: string): boolean {
  return (
    CONTROL.has(type) ||
    type.startsWith("oxagen:") ||
    type.startsWith("admission.")
  );
}

function eventRows(step: TranscriptStep): FeedRow[] {
  const { first } = step;
  const spent = step.last.cumulativeCost;
  const text = soleText(step.frames);
  const own = first.subagent === undefined;
  if (isOperatorPrompt(first)) {
    if (text === null) return [];
    return [
      {
        ...base(step.id, first, "prompt", spent),
        kind: "prompt",
        text,
        turn: first.turn,
        first: false,
        haystack: haystack([text]),
      },
    ];
  }
  if (first.type === "turn_end" || first.type === MESSAGE) {
    if (text === null) return [];
    return [
      {
        ...base(step.id, first, "responses", spent),
        kind: "text",
        text,
        haystack: haystack([text]),
      },
    ];
  }
  if (first.kinds.includes("recall")) {
    const recall = recallOf(step);
    return [
      {
        ...base(step.id, first, "recall", spent),
        kind: "recall",
        recall,
        frame: refOf(first),
        haystack: haystack([
          first.type,
          ...recall.items.map((item) => item.label),
        ]),
      },
    ];
  }
  if (SEAL.has(first.type) && own) {
    return [
      {
        ...base(step.id, first, "seal", spent),
        kind: "seal",
        label: first.label === first.type ? null : first.label,
        frame: refOf(first),
        haystack: haystack([first.type, first.label]),
      },
    ];
  }
  const gates = gatesOf(step.frames);
  // The harness refusing a call is a row even though Oxagen decided nothing:
  // the call it stopped never ran. The harness allowing one is not, because
  // Claude Code checks every call and a row per check buried the calls.
  const refused = step.frames.some(harnessDenied);
  const failed =
    refused ||
    step.frames.some((frame) => frame.kinds.includes("errors")) ||
    gates.some((gate) => DENIED.test(gate.decision));
  if (gates.length === 0 && !failed && (text === null || isQuiet(first.type)))
    return [];
  // A decision on no recorded call is named by the call its label names, and
  // a harness refusal by the tool it refused (`deny Bash`).
  const refusedTool = refused ? first.label.split(" ")[1] : undefined;
  const name = policySubject(first) ?? refusedTool ?? first.type;
  return [
    {
      ...base(step.id, first, null, spent),
      failed,
      kind: "event",
      name,
      text,
      gates,
      frame: refOf(first),
      haystack: haystack([name, text]),
    },
  ];
}

/**
 * Whether a reply's `tool_use` block names a call a tool step of the turn
 * recorded, so the call is drawn once, as the tool's row. By call key where
 * both sides recorded one; otherwise the next unclaimed tool step of the same
 * name after the reply.
 */
function claimer(
  turn: TranscriptTurn,
  after: TranscriptStep,
  claimed: Set<string>,
): (block: ToolUse) => boolean {
  const tools = flatSteps(turn).filter((step) => step.kind === "tool");
  const keyed = new Set(
    tools.flatMap((step) =>
      step.frames.flatMap((frame) =>
        frame.callKey === null ? [] : [frame.callKey],
      ),
    ),
  );
  return (block) => {
    if (block.callKey !== null && keyed.has(block.callKey)) return true;
    const name = toolDetailOf(block.name, null)?.name ?? block.name;
    const match = tools.find(
      (tool) =>
        tool.from > after.to &&
        !claimed.has(tool.id) &&
        (tool.first.callKey === null || block.callKey === null) &&
        (stepTool(tool)?.name ?? stepDigest(tool).name) === name,
    );
    if (match === undefined) return false;
    claimed.add(match.id);
    return true;
  };
}

/**
 * Whether a text row is the run's own copy of a prompt the turn already draws
 * as its prompt row: a message or turn-end frame on the run's own chain whose
 * text is the operator's words. A subagent's frames never match, so the words
 * a parent sent its subagent keep their row.
 */
function echoesPrompt(
  step: TranscriptStep,
  text: string,
  asked: ReadonlySet<string>,
): boolean {
  const { first } = step;
  return (
    first.subagent === undefined &&
    (first.type === MESSAGE || first.type === "turn_end") &&
    asked.has(text)
  );
}

/**
 * The run as the Transcript tab's rows, in the order the steps happened
 * (mockup `txEntries`). Every row is read from the frames; a frame with
 * nothing to read (a hook registering, a turn boundary with no body, a
 * digest-only copy of a call another source sealed with its body) gets no
 * row, and the Governed actions tab still has it.
 */
export function buildFeed(entries: readonly TranscriptEntry[]): FeedRow[] {
  const results = toolResults(entries);
  const rows: FeedRow[] = [];
  const claimed = new Set<string>();
  for (const turn of buildTranscript(entries)) {
    // The operator's words for this turn. A run recorded before #4051 also
    // sealed the transcript's copy of the prompt with its text, as a message
    // frame, so that copy would draw the prompt a second time.
    const asked = new Set(
      turn.steps.flatMap((step) => {
        if (!isOperatorPrompt(step.first)) return [];
        const text = soleText(step.frames);
        return text === null ? [] : [text.trim()];
      }),
    );
    // The last words drawn in this turn: a turn's closing message repeats
    // the reply the model gave when both were recorded, and is one row.
    let said: string | null = null;
    const draw = (step: TranscriptStep, parent: string | null): void => {
      const made =
        step.kind === "tool"
          ? [toolRow(step)]
          : step.kind === "model"
            ? modelRows(step, claimer(turn, step, claimed), results)
            : eventRows(step);
      for (const row of made) {
        if (row.kind === "text") {
          const text = row.text.trim();
          if (echoesPrompt(step, text, asked)) continue;
          if (said !== null && text === said) continue;
          said = text;
        }
        rows.push(parent === null ? row : { ...row, parent });
      }
      // A subagent's steps follow the Task or Agent call that spawned them,
      // each row naming that call's row as its parent (`nestSubagents`).
      for (const child of step.children ?? []) draw(child, step.id);
    };
    for (const step of turn.steps) draw(step, null);
  }
  const first = rows.findIndex((row) => row.kind === "prompt");
  return rows.map((row, index) =>
    index === first && row.kind === "prompt" ? { ...row, first: true } : row,
  );
}
