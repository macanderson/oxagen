// What the Governed actions tab draws, derived from the record (mockup `pRun`'s
// player: `runTimeline`, `fpBar`, `fkOf`, `fpMark` and `frameDetail`'s
// approval card, pages/run.md "Governed actions").
//
// Pure, so every rule is tested without a render. The inputs are the page of
// frames `get_run` answered, the whole-run transcript at `everything` (one
// entry per frame, carrying the turn and the decision the contract derived),
// and the approvals recorded on the run. Nothing here invents a value: a turn
// the transcript did not carry draws no band, a decision it did not carry
// draws no hue, and an approval the record cannot tie to a frame is left
// unmatched rather than pinned to the nearest one.
import type { ApprovalItem } from "@/data/contracts/approvals";
import type {
  RunFrame,
  RunTranscript,
  TranscriptEntry,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";

/** A frame's position as the contract spells it (`frameSeqSchema`): decimal, at most 19 digits. */
const FRAME_SEQ = /^\d{1,19}$/;

/**
 * The six classes a frame folds into (`FK_ORDER`), in the legend's order.
 * Five carry a categorical hue of their own; lifecycle is neutral.
 */
const FRAME_KINDS = ["model", "tool", "gov", "ctx", "op", "life"] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/**
 * The wrapper's record of an operator command reaching the session (tacho
 * `hook-handler.ts`, `inbox.ts`): the spec's `control.*` frame in the wrapped
 * vocabulary, sealed with `policy_source: human`.
 */
const COMMAND_APPLIED = "oxagen:command_applied";

/**
 * `fkOf`, read against the types the stores record. The mockup's rule, plus
 * three spellings it does not know: a wrapped model call is `llm_call`, the
 * steering the assembler put in front of the agent is `steering.manifest`,
 * and a wrapped operator command is `oxagen:command_applied`.
 */
export function kindOf(type: string): FrameKind {
  if (type.startsWith("model.") || type === "llm_call") return "model";
  if (type.startsWith("tool")) return "tool";
  if (/^(policy|token|approval|credential)/.test(type)) return "gov";
  if (type.startsWith("context") || type === "steering.manifest") return "ctx";
  if (type.startsWith("control.") || type === COMMAND_APPLIED) return "op";
  return "life";
}

/** How many frames of each class the page shows, in the legend's order; a class with none is left out. */
export function kindCounts(
  frames: readonly RunFrame[],
): { kind: FrameKind; count: number }[] {
  const counts = new Map<FrameKind, number>();
  for (const frame of frames) {
    const kind = kindOf(frame.type);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return FRAME_KINDS.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count === 0 ? [] : [{ kind, count }];
  });
}

/**
 * The run's own frames at `everything`, by seq. A subagent's entries are left
 * out: its chain is numbered from 0 like the run's, so its seq names a frame
 * of another chain, and the page of frames is the run's own.
 */
export function entriesBySeq(
  read: Read<RunTranscript>,
): ReadonlyMap<string, TranscriptEntry> {
  const map = new Map<string, TranscriptEntry>();
  if (!read.ok) return map;
  for (const entry of read.value.entries) {
    if (entry.subagent === undefined && !map.has(entry.seq))
      map.set(entry.seq, entry);
  }
  return map;
}

/** The decision word the transcript recorded for a frame; null when it recorded none. */
export function decisionOf(entry: TranscriptEntry | undefined): string | null {
  return entry?.decision?.decision ?? null;
}

/** The in-app assistant's tool receipt in the ledger. */
const TOOL_RECEIPT = "tool.engine_call_completed";

/**
 * What a ledger tool receipt records about a call parked for approval, or
 * null when the frame is not one. The ledger's summary (the transcript's
 * label) reads `<tool> parked`, then the public id of the approval the call
 * waits on when the receipt named one: `create_workspace parked apr_…`.
 * `approvalId` is null when it named none.
 */
export function parkedReceipt(
  type: string,
  summary: string,
): { approvalId: string | null } | null {
  if (type !== TOOL_RECEIPT) return null;
  const [, outcome, approvalId] = summary.split(/\s+/);
  if (outcome !== "parked") return null;
  return { approvalId: approvalId ?? null };
}

/**
 * A frame that needs a person: the approval request itself, the policy
 * decision that asked for one (`ask` in the wrapper's closed vocabulary,
 * tacho `POLICY_DECISIONS`), or a ledger receipt for a call that parked.
 * `summary` is only read for that last case.
 */
export function isParked(
  type: string,
  decision: string | null,
  summary = "",
): boolean {
  return (
    type === "approval_request" ||
    (type === "policy_decision" && decision === "ask") ||
    parkedReceipt(type, summary) !== null
  );
}

/**
 * `fpMark`: the state hue a governed frame carries in the list and under the
 * scrub. A decision takes the hue of what was decided, so a denial never
 * reads as an allow; a decision the transcript did not carry is quiet.
 */
export type Mark = "allowed" | "approval" | "denied" | "proven" | "quiet";

export function markOf(
  type: string,
  decision: string | null,
  summary = "",
): Mark | null {
  if (type === "policy_decision" || type === "approval_decision") {
    if (decision === "allow") return "allowed";
    if (decision === "deny") return "denied";
    if (decision === "ask" || decision === "defer") return "approval";
    return "quiet";
  }
  if (type === "approval_request") return "approval";
  if (parkedReceipt(type, summary) !== null) return "approval";
  if (kindOf(type) === "op") return "proven";
  if (type === "tool_requested" || type === "tool_call") return "quiet";
  return null;
}

/** `runTimeline`'s placement: a tick at least 1.7% from the last, the whole scaled into 97%. */
const MIN_GAP = 1.7;
const TRACK = 97;

/**
 * Each frame's left edge on the track, in percent, from its recorded instant.
 * Frames recorded in the same instant still get a tick each.
 */
export function tickPositions(frames: readonly RunFrame[]): number[] {
  const times = frames.map((frame) => Date.parse(frame.observedAt));
  const t0 = times[0];
  const t1 = times.at(-1);
  if (t0 === undefined || t1 === undefined) return [];
  const span = Math.max(1, t1 - t0);
  const xs = times.map((time) => ((time - t0) / span) * 100);
  for (let i = 1; i < xs.length; i++) {
    const before = xs[i - 1] ?? 0;
    if ((xs[i] ?? 0) < before + MIN_GAP) xs[i] = before + MIN_GAP;
  }
  const last = xs.at(-1) ?? 0;
  return last > TRACK ? xs.map((x) => (x / last) * TRACK) : xs;
}

export type Band = {
  turn: number;
  /** Percent of the track. */
  left: number;
  width: number;
  /** Every other band is drawn clear. */
  alt: boolean;
  /** A `control.steer` frame opens the band or sits just before it. */
  afterSteer: boolean;
};

/**
 * The turn bands: one per stretch of frames the transcript placed in the same
 * turn. Frames it placed before the first turn, or did not carry, sit outside
 * every band rather than in a turn guessed for them.
 */
export function turnBands(
  frames: readonly RunFrame[],
  xs: readonly number[],
  entries: ReadonlyMap<string, TranscriptEntry>,
): Band[] {
  const turns = frames.map((frame) => entries.get(frame.seq)?.turn ?? null);
  const bands: Band[] = [];
  let i = 0;
  while (i < frames.length) {
    const turn = turns[i] ?? null;
    let j = i + 1;
    while (j < frames.length && (turns[j] ?? null) === turn) j++;
    if (turn !== null) {
      const left = Math.max(0, (xs[i] ?? 0) - 1.2);
      const right = j < frames.length ? (xs[j] ?? 100) - 1.2 : 100;
      bands.push({
        turn,
        left,
        width: Math.max(0, right - left),
        alt: bands.length % 2 === 1,
        afterSteer:
          frames[i]?.type === "control.steer" ||
          frames[i - 1]?.type === "control.steer",
      });
    }
    i = j;
  }
  return bands;
}

export type TimelineMark = { at: number; kind: "steer" | "parked" };

/**
 * "steer" over each `control.steer` frame, and "parked · approval" over each
 * frame that needs a person, once for a pair that sit side by side (the
 * decision that asked, then the request it raised).
 */
export function timelineMarks(
  frames: readonly RunFrame[],
  xs: readonly number[],
  entries: ReadonlyMap<string, TranscriptEntry>,
): TimelineMark[] {
  const marks: TimelineMark[] = [];
  let parkedAt = -2;
  frames.forEach((frame, i) => {
    const at = xs[i] ?? 0;
    if (frame.type === "control.steer") marks.push({ at, kind: "steer" });
    if (
      isParked(frame.type, decisionOf(entries.get(frame.seq)), frame.summary)
    ) {
      if (i - parkedAt > 1) marks.push({ at, kind: "parked" });
      parkedAt = i;
    }
  });
  return marks;
}

/** The frame open in the player: `?body=` when it names one, else the first frame shown. */
export type OpenFrame = {
  seq: string;
  /** Its place on the page; -1 when the URL named a frame this page does not hold. */
  index: number;
  /** The frame itself when the page holds it. */
  frame: RunFrame | null;
  /**
   * The URL named it. Its body is read only then: the first frame shown is
   * open by default, and a body is read when a person asks for it.
   */
  named: boolean;
};

export function openFrameOf(
  frames: readonly RunFrame[],
  body: string | null,
): OpenFrame | null {
  if (body !== null && FRAME_SEQ.test(body)) {
    const index = frames.findIndex((frame) => frame.seq === body);
    return { seq: body, index, frame: frames[index] ?? null, named: true };
  }
  const first = frames[0];
  return first === undefined
    ? null
    : { seq: first.seq, index: 0, frame: first, named: false };
}

/** Two decimal seqs in order, without reading either as a number a double cannot hold. */
function compareSeq(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

export type Steps = {
  first: string | null;
  prev: string | null;
  next: string | null;
  last: string | null;
};

/**
 * Where ◀ and ▶ lead from the open frame: its neighbours on the page, or for
 * a frame the page does not hold, the nearest shown frames either side of it.
 */
export function stepsOf(frames: readonly RunFrame[], open: OpenFrame): Steps {
  const first = frames[0]?.seq ?? null;
  const last = frames.at(-1)?.seq ?? null;
  if (open.index >= 0) {
    return {
      first,
      last,
      prev: frames[open.index - 1]?.seq ?? null,
      next: frames[open.index + 1]?.seq ?? null,
    };
  }
  const before = frames.filter((frame) => compareSeq(frame.seq, open.seq) < 0);
  const after = frames.find((frame) => compareSeq(frame.seq, open.seq) > 0);
  return {
    first,
    last,
    prev: before.at(-1)?.seq ?? null,
    next: after?.seq ?? null,
  };
}

/** The run as the list panel names it: live, paused, sealed, or halted, as recorded. */
export type RunState = "live" | "paused" | "sealed" | "halted";

export function runStateOf(run: RunRow): RunState {
  if (run.status === "live")
    return run.ingressPaused === true ? "paused" : "live";
  return run.status;
}

/**
 * The frames an approval can be recorded on: the request that parked it, and
 * the decision that settled it. A ledger receipt for a parked call is a
 * request too (`parkedReceipt`), read from its summary rather than its type.
 */
const REQUEST_FRAMES: ReadonlySet<string> = new Set([
  "approval_request",
  "tool.approval_recorded",
]);
const DECISION_FRAMES: ReadonlySet<string> = new Set(["approval_decision"]);

export function isApprovalFrame(type: string, summary = ""): boolean {
  return (
    REQUEST_FRAMES.has(type) ||
    DECISION_FRAMES.has(type) ||
    parkedReceipt(type, summary) !== null
  );
}

/** An approval as matching reads it: pending ones carry no `resolvedAt`. */
type Matchable = Pick<ApprovalItem, "id" | "tool" | "createdAt"> & {
  resolvedAt?: string;
};

type Matches<T> = {
  /** The approval each approval frame on the page records, by frame seq. */
  byFrame: ReadonlyMap<string, T>;
  /** The ids some frame on the page records. */
  matched: ReadonlySet<string>;
};

/**
 * Which approval frame on the page records which approval.
 *
 * A ledger receipt for a parked call names its approval's public id, so it
 * pairs with that approval and no other, ahead of any match by instant.
 *
 * Every other approval frame carries no approval id, and the approval row
 * carries no seq, so the match reads the two things both record: the tool
 * (the frame's summary names it, tacho `tachoFrameSummary`) and the instant
 * (a request frame is recorded when the call parked, a decision frame when it
 * was settled). A frame and an approval pair only when the frame names the
 * approval's tool, and among those the closest instants pair first. A frame
 * that names no tool, as a ledger `tool.approval_recorded` does, matches
 * nothing: its approval stays unmatched and the tab lists it where no frame
 * hides it.
 */
export function matchApprovals<T extends Matchable>(
  frames: readonly RunFrame[],
  items: readonly T[],
): Matches<T> {
  const pairs: {
    seq: string;
    item: T;
    group: "request" | "decision";
    distance: number;
    order: number;
  }[] = [];
  frames.forEach((frame, order) => {
    if (!isApprovalFrame(frame.type, frame.summary)) return;
    const tokens = frame.summary.split(/\s+/);
    const group = DECISION_FRAMES.has(frame.type) ? "decision" : "request";
    const at = Date.parse(frame.observedAt);
    const named = parkedReceipt(frame.type, frame.summary)?.approvalId ?? null;
    for (const item of items) {
      if (named === null ? !tokens.includes(item.tool) : item.id !== named)
        continue;
      const ref = group === "decision" ? item.resolvedAt : item.createdAt;
      if (ref === undefined) continue;
      pairs.push({
        seq: frame.seq,
        item,
        group,
        // A pair by id is exact, so it sorts ahead of every pair by instant.
        distance: named === null ? Math.abs(at - Date.parse(ref)) : -1,
        order,
      });
    }
  });
  pairs.sort((a, b) => a.distance - b.distance || a.order - b.order);
  const byFrame = new Map<string, T>();
  const taken = new Set<string>();
  const matched = new Set<string>();
  for (const pair of pairs) {
    const key = `${pair.group}:${pair.item.id}`;
    if (byFrame.has(pair.seq) || taken.has(key)) continue;
    byFrame.set(pair.seq, pair.item);
    taken.add(key);
    matched.add(pair.item.id);
  }
  return { byFrame, matched };
}
