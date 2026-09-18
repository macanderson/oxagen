/**
 * One frame shape for a run from either store (Mission Control spec §8.2;
 * ADR-058), and the pure reads over it: the transcript fold at three zoom
 * levels (§14) and the bisect alignment (§8.4).
 *
 * The evidence ledger records a run's frames as V2 events
 * (`agent.agent_run_events`, `AttemptEventReadRecord`); a wrapped agent's
 * frames are the session's hash-chained events in ClickHouse `tacho_events`.
 * The handlers and the durable jobs both read runs from both stores, so the
 * projection lives here, below both: the ledger record maps directly, and
 * the ClickHouse row maps through a structural type so this package needs
 * nothing from `@oxagen/telemetry`.
 *
 * Nothing here reads a body. A frame carries its body reference; the text a
 * transcript entry shows is fetched by the caller for the frames the fold
 * names, and folded in with `withText`.
 */
import type { AttemptEventReadRecord } from "./run-store";
import type { FrameBodyColumns } from "./frame-body";
import {
  isTranscriptKind,
  TRANSCRIPT_KINDS,
  type Redaction,
  type TranscriptKind,
} from "@oxagen/tacho";

/** What a frame did, as far as its receipt says. Null where it says nothing. */
export interface FrameIdentity {
  tool: string | null;
  toolStatus: string | null;
  model: string | null;
  policy: string | null;
  verdict: string | null;
  contextRows: number | null;
  /**
   * The call the frame belongs to (`tool_call_id`, `model_call_id`), so the
   * two halves of one exchange pair on identity and not on adjacency. Null
   * where the producer records none — a wrapped session's rows carry no call
   * id, and those pair on adjacency within the step kind instead.
   */
  callId: string | null;
}

/**
 * Which half of an exchange the frame records. A step is one request and one
 * response; a producer that appends a single terminal receipt for the whole
 * exchange records `single`, and its body is the result (see `TranscriptFold`).
 */
export type FramePhase = "request" | "response" | "single";

export interface RunFrame {
  /** The ledger's `run_seq` or the session's dense `seq`, decimal. */
  seq: string;
  /** The recorded event type (ledger) or kind (wrapped). */
  type: string;
  /** The evidence stage (ledger) or the stage a wrapped kind belongs to. */
  stage: string;
  observedAt: Date;
  /** The frame's own digest: `event_digest` or the chain `hash`. */
  digest: string;
  /** A short machine-derived label from identifiers in the receipt. */
  summary: string;
  body: FrameBodyColumns;
  /** The frame's own cost record, micro-USD; null when it carried none. */
  costMicros: number | null;
  /** The turn the frame belongs to; null when the receipt carries none. */
  turnIndex: number | null;
  /** Which half of its exchange the frame records. */
  phase: FramePhase;
  identity: FrameIdentity;
}

const NO_IDENTITY: FrameIdentity = {
  tool: null,
  toolStatus: null,
  model: null,
  policy: null,
  verdict: null,
  contextRows: null,
  callId: null,
};

// ── Ledger ──────────────────────────────────────────────────────────────────

function field(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberField(payload: unknown, key: string): number | null {
  const value = field(payload, key);
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A short label: identifiers from the inline receipt metadata, never prose.
 * An encrypted payload shows its event type and nothing it cannot read.
 */
export function ledgerFrameSummary(event: AttemptEventReadRecord): string {
  const p = event.payload;
  switch (event.eventType) {
    case "admission.run_admitted": {
      const name = field(p, "engine_name");
      const version = field(p, "engine_version");
      return name && version ? `${name}@${version}` : event.eventType;
    }
    case "context.frames_selected": {
      const frames = field(p, "frame_count");
      return frames ? `frames=${frames}` : event.eventType;
    }
    case "model.call_completed":
    case "model.engine_call_started":
    case "model.engine_call_completed": {
      const provider = field(p, "provider");
      const model = field(p, "model");
      return provider && model ? `${provider}/${model}` : event.eventType;
    }
    case "tool.call_completed": {
      const capability = field(p, "capability_name");
      const outcome = field(p, "outcome");
      return capability && outcome
        ? `${capability} ${outcome}`
        : event.eventType;
    }
    case "tool.engine_call_started":
    case "tool.engine_call_completed": {
      // The engine's own halves name the tool `tool_name`, not
      // `capability_name`; reading only the latter left every in-app tool
      // call labelled with its bare event type.
      const tool = field(p, "tool_name");
      const outcome = field(p, "outcome");
      if (!tool) return event.eventType;
      return outcome ? `${tool} ${outcome}` : tool;
    }
    default:
      return event.eventType;
  }
}

function ledgerIdentity(event: AttemptEventReadRecord): FrameIdentity {
  const p = event.payload;
  switch (event.eventType) {
    case "tool.call_completed":
      return {
        ...NO_IDENTITY,
        tool: field(p, "capability_name"),
        toolStatus: field(p, "outcome"),
      };
    case "tool.engine_call_started":
    case "tool.engine_call_completed":
      return {
        ...NO_IDENTITY,
        tool: field(p, "tool_name"),
        toolStatus: field(p, "outcome"),
        callId: field(p, "tool_call_id"),
      };
    case "model.call_completed": {
      const provider = field(p, "provider");
      const model = field(p, "model");
      return {
        ...NO_IDENTITY,
        model: provider && model ? `${provider}/${model}` : model,
      };
    }
    case "model.engine_call_started":
    case "model.engine_call_completed": {
      const provider = field(p, "provider");
      const model = field(p, "model");
      return {
        ...NO_IDENTITY,
        model: provider && model ? `${provider}/${model}` : model,
        callId: field(p, "model_call_id"),
      };
    }
    case "tool.approval_recorded":
      return { ...NO_IDENTITY, policy: field(p, "decision") };
    case "verification.completed":
      return { ...NO_IDENTITY, verdict: field(p, "verdict") };
    case "context.frames_selected":
      return { ...NO_IDENTITY, contextRows: numberField(p, "frame_count") };
    default:
      return NO_IDENTITY;
  }
}

/**
 * Which half of its exchange a recorded type is. The ledger's write-ahead
 * intentions (`*.engine_call_started`) are the request; the engine's terminal
 * receipts are the response; a submitting engine's single `*.call_completed`
 * receipt stands for the whole exchange.
 */
const LEDGER_PHASES: Readonly<Record<string, FramePhase>> = {
  "model.engine_call_started": "request",
  "tool.engine_call_started": "request",
  "model.engine_call_completed": "response",
  "tool.engine_call_completed": "response",
};

export function ledgerPhase(eventType: string): FramePhase {
  return LEDGER_PHASES[eventType] ?? "single";
}

/** A ledger event as a run frame. Ledger frames carry no cost record (§12). */
export function ledgerFrame(event: AttemptEventReadRecord): RunFrame {
  return {
    seq: event.runSeq,
    type: event.eventType,
    stage: event.stage,
    observedAt: event.observedAt,
    digest: event.eventDigest,
    summary: ledgerFrameSummary(event),
    body: event.body,
    costMicros: null,
    turnIndex:
      event.eventType === "model.call_completed"
        ? numberField(event.payload, "turn_index")
        : null,
    phase: ledgerPhase(event.eventType),
    identity: ledgerIdentity(event),
  };
}

// ── Wrapped (tacho) ─────────────────────────────────────────────────────────

/** The `tacho_events` columns the projection reads, as the telemetry seam returns them. */
export interface TachoFrameRowLike {
  seq: number;
  /** ClickHouse DateTime64 text. */
  ts: string;
  kind: string;
  hash: string;
  contentDigest: string;
  bytesRef: string;
  redactions: string;
  toolName: string;
  toolStatus: string;
  model: string;
  provider: string;
  policyDecision: string;
  costUsdMicros: number | null;
  turnSeq: number | null;
}

/** Which half of its exchange a wrapped kind records. */
const TACHO_PHASES: Readonly<Record<string, FramePhase>> = {
  "model.request": "request",
  tool_requested: "request",
  "model.response": "response",
  tool_call: "response",
};

export function tachoPhase(kind: string): FramePhase {
  return TACHO_PHASES[kind] ?? "single";
}

/** The stage a wrapped kind belongs to (tacho spec §6.1 kinds). */
export function tachoStage(kind: string): string {
  switch (kind) {
    case "agent_start":
    case "agent_stop":
    case "subagent_start":
    case "subagent_stop":
      return "session";
    case "turn_start":
    case "turn_end":
      return "turn";
    case "llm_call":
    case "model.request":
    case "model.response":
    case "context.assembled":
      return "model";
    case "tool_requested":
    case "tool_call":
      return "tool";
    case "policy_decision":
    case "approval_request":
    case "approval_decision":
    case "token_issued":
    case "token_use":
    case "token_denied":
      return "policy";
    case "file_io":
    case "network":
    case "command":
      return "effect";
    case "proof.observed":
      return "proof";
    default:
      return kind.startsWith("oxagen:") ? "control" : "chain";
  }
}

const blank = (v: string): string | null => (v === "" ? null : v);

function tachoRedactions(text: string): Redaction[] {
  if (text === "" || text === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Redaction[]) : [];
  } catch {
    return [];
  }
}

/** ClickHouse renders DateTime64 as `YYYY-MM-DD HH:MM:SS.mmm` in UTC. */
export function tachoTimestamp(ts: string): Date {
  const iso = /^\d{4}-\d{2}-\d{2} /.test(ts) ? `${ts.replace(" ", "T")}Z` : ts;
  return new Date(iso);
}

export function tachoFrameSummary(row: TachoFrameRowLike): string {
  switch (row.kind) {
    case "tool_requested":
    case "tool_call":
      return row.toolName
        ? `${row.toolName}${row.toolStatus ? ` ${row.toolStatus}` : ""}`
        : row.kind;
    case "llm_call":
      return row.model
        ? row.provider
          ? `${row.provider}/${row.model}`
          : row.model
        : row.kind;
    case "policy_decision":
      return row.policyDecision ? `policy ${row.policyDecision}` : row.kind;
    default:
      return row.kind;
  }
}

/** A `tacho_events` row as a run frame. */
export function tachoFrame(row: TachoFrameRowLike): RunFrame {
  const digest = blank(row.contentDigest);
  const ref = blank(row.bytesRef);
  const body: FrameBodyColumns =
    digest === null
      ? {
          bodyRef: null,
          bodyDigest: null,
          bodyBytes: null,
          redactions: null,
          fidelity: "digest_only",
        }
      : {
          bodyRef: ref,
          bodyDigest: digest,
          bodyBytes: null,
          redactions: tachoRedactions(row.redactions),
          fidelity: ref === null ? "digest_only" : "full",
        };
  const model = blank(row.model);
  return {
    seq: String(row.seq),
    type: row.kind,
    stage: tachoStage(row.kind),
    observedAt: tachoTimestamp(row.ts),
    digest: row.hash,
    summary: tachoFrameSummary(row),
    body,
    costMicros: row.costUsdMicros,
    turnIndex: row.turnSeq,
    phase: tachoPhase(row.kind),
    identity: {
      tool: blank(row.toolName),
      toolStatus: blank(row.toolStatus),
      model:
        model === null
          ? null
          : row.provider
            ? `${row.provider}/${model}`
            : model,
      policy: blank(row.policyDecision),
      verdict: null,
      contextRows: null,
      // `tacho_events` records no call id, so a wrapped session's two halves
      // pair on adjacency within their step kind (`foldTranscript`).
      callId: null,
    },
  };
}

// ── Bisect ──────────────────────────────────────────────────────────────────

/**
 * The bisect key (Mission Control mockup `bisKey`): the kind, then the call
 * identity — tool and status, model, policy outcome, proof verdict, context
 * row count. Two frames with equal keys did the same thing as far as the
 * record says; bodies are not part of the key, so bisect works at `inspect`.
 */
export function bisectKey(frame: RunFrame): string {
  const { identity: id } = frame;
  const parts = [frame.type];
  if (id.tool !== null)
    parts.push(id.toolStatus ? `${id.tool}=${id.toolStatus}` : id.tool);
  if (id.model !== null) parts.push(id.model);
  if (id.policy !== null) parts.push(`policy=${id.policy}`);
  if (id.verdict !== null) parts.push(`verdict=${id.verdict}`);
  if (id.contextRows !== null) parts.push(`rows=${id.contextRows}`);
  return parts.join(":");
}

export interface BisectResult {
  divergentSeq: string | null;
  keyA: string | null;
  keyB: string | null;
  aligned: number;
}

/**
 * Walk both runs in position order and stop at the first position whose
 * keys differ. Position is the index into each run's frame list, so the two
 * recordings need not share a numbering; the answered `divergentSeq` is run
 * A's sequence there, or run B's when A has ended.
 */
export function bisectFrames(
  a: readonly RunFrame[],
  b: readonly RunFrame[],
): BisectResult {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const keyA = bisectKey(a[i] as RunFrame);
    const keyB = bisectKey(b[i] as RunFrame);
    if (keyA !== keyB) {
      return { divergentSeq: (a[i] as RunFrame).seq, keyA, keyB, aligned: i };
    }
  }
  if (a.length === b.length) {
    return { divergentSeq: null, keyA: null, keyB: null, aligned: n };
  }
  const longer = a.length > b.length ? a : b;
  const frame = longer[n] as RunFrame;
  return {
    divergentSeq: frame.seq,
    keyA: a.length > n ? bisectKey(frame) : null,
    keyB: b.length > n ? bisectKey(frame) : null,
    aligned: n,
  };
}

// ── Transcript ──────────────────────────────────────────────────────────────

export type TranscriptZoom = "turns" | "steps" | "everything";
export type TranscriptEntryKind =
  | "turn"
  | "model_call"
  | "tool_call"
  | "policy"
  | "frame";

// The chip vocabulary is the leaf package's (`@oxagen/tacho`), so the contract
// that publishes it as an enum and this projection that derives it read one
// list. Re-exported here so a caller over frames has one import site.
export { isTranscriptKind, TRANSCRIPT_KINDS, type TranscriptKind };

/**
 * Model-stage frame types, both vocabularies and both halves. The engine's own
 * calls (`model.engine_call_*`, ADR-043) were missing here, so every in-app
 * run's model exchanges folded into whatever step preceded them instead of
 * opening one, and the `steps` transcript of an in-app run showed no model
 * calls at all.
 */
const MODEL_TYPES: ReadonlySet<string> = new Set([
  "model.call_completed",
  "model.engine_call_started",
  "model.engine_call_completed",
  "llm_call",
  "model.request",
  "model.response",
]);
/** Tool-stage frame types, both vocabularies and both halves. */
const TOOL_TYPES: ReadonlySet<string> = new Set([
  "tool.call_completed",
  "tool.engine_call_started",
  "tool.engine_call_completed",
  "tool_call",
  "tool_requested",
]);
/** Frames that record a decision a rule or a person made about a call. */
const POLICY_TYPES: ReadonlySet<string> = new Set([
  "tool.approval_recorded",
  "policy_decision",
  "approval_request",
  "approval_decision",
  "token_issued",
  "token_use",
  "token_denied",
]);
/** Frames that record what was pulled into the model's context. */
const RECALL_TYPES: ReadonlySet<string> = new Set([
  "context.frames_selected",
  "context.assembled",
]);
/** Frames a producer writes to open a turn. */
const TURN_OPENERS: ReadonlySet<string> = new Set(["turn_start"]);

/** Tool outcomes that record a call that did not do what it was asked to. */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set([
  "failed",
  "denied",
  "cancelled",
  "error",
  "timeout",
  "refused",
]);

/**
 * Every chip a frame answers to. A frame may answer several: a failed tool
 * result is both `tools` and `errors`, and a model response that carried a
 * cost record is both `responses` and `usage`.
 */
export function frameKinds(frame: RunFrame): TranscriptKind[] {
  const kinds = new Set<TranscriptKind>();
  if (MODEL_TYPES.has(frame.type)) {
    kinds.add(frame.phase === "request" ? "prompt" : "responses");
  }
  if (TOOL_TYPES.has(frame.type)) kinds.add("tools");
  if (POLICY_TYPES.has(frame.type)) kinds.add("policy");
  if (RECALL_TYPES.has(frame.type)) kinds.add("recall");
  if (frame.costMicros !== null) kinds.add("usage");
  const status = frame.identity.toolStatus;
  if (status !== null && FAILED_OUTCOMES.has(status)) kinds.add("errors");
  if (frame.type === "error" || frame.type.endsWith(".error")) {
    kinds.add("errors");
  }
  return [...kinds];
}

/**
 * The frames a chip selection keeps, in order. An empty selection keeps
 * everything: no chip pressed is not the same as every chip pressed off.
 *
 * The filter runs over frames and the fold runs over what is left, so a
 * filtered transcript is the transcript of those frames — a `tools` selection
 * pairs the two halves of each tool call exactly as the unfiltered one does.
 */
export function filterFramesByKind(
  frames: readonly RunFrame[],
  kinds: readonly TranscriptKind[],
): RunFrame[] {
  if (kinds.length === 0) return [...frames];
  const wanted = new Set<TranscriptKind>(kinds);
  return frames.filter((frame) =>
    frameKinds(frame).some((kind) => wanted.has(kind)),
  );
}

/** A decision a rule or a person made about the call an entry records. */
export interface TranscriptDecision {
  seq: string;
  /** The recorded word: `allow`, `deny`, `route`, or whatever the rule wrote. */
  decision: string;
  type: string;
  at: Date;
}

/**
 * One transcript entry before its text is attached.
 *
 * `request` and `response` are the two halves of the exchange the entry
 * records: the frame that carried what went out and the frame that carried
 * what came back. A producer that appends a single terminal receipt for the
 * whole exchange (`tool.call_completed`, `llm_call`) records it as the
 * `response`, because its body is the result; `request` is then null.
 */
export interface TranscriptFold {
  /** The frame that opens the entry. */
  opening: RunFrame;
  endSeq: string;
  kind: TranscriptEntryKind;
  frames: number;
  /** Summed cost records of the folded frames; null when none carried one. */
  costMicros: number | null;
  request: RunFrame | null;
  response: RunFrame | null;
  /** The last decision frame folded into the entry; null when none was. */
  decision: TranscriptDecision | null;
}

export function stepKind(frame: RunFrame): "model_call" | "tool_call" | null {
  if (MODEL_TYPES.has(frame.type)) return "model_call";
  if (TOOL_TYPES.has(frame.type)) return "tool_call";
  return null;
}

function addCost(sum: number | null, cost: number | null): number | null {
  if (cost === null) return sum;
  return (sum ?? 0) + cost;
}

function decisionOf(frame: RunFrame): TranscriptDecision | null {
  if (!POLICY_TYPES.has(frame.type)) return null;
  return {
    seq: frame.seq,
    decision: frame.identity.policy ?? frame.type,
    type: frame.type,
    at: frame.observedAt,
  };
}

/** A new fold opened at `frame`, with its own half already in place. */
function open(frame: RunFrame, kind: TranscriptEntryKind): TranscriptFold {
  return {
    opening: frame,
    endSeq: frame.seq,
    kind,
    frames: 1,
    costMicros: frame.costMicros,
    request: frame.phase === "request" ? frame : null,
    response: frame.phase === "request" ? null : frame,
    decision: decisionOf(frame),
  };
}

/**
 * Fold `frame` into `current`, which keeps its opening frame.
 *
 * Only a frame that is itself a step half may fill one of the two slots. A
 * decision, a turn boundary or a context assembly folds into the step for its
 * timing and its cost, but it is not what the call was made with or what came
 * back — letting one take the response slot made the real result open a
 * second entry, which is the two-entries-per-tool-call shape this fold exists
 * to end.
 */
function absorb(current: TranscriptFold, frame: RunFrame): void {
  current.endSeq = frame.seq;
  current.frames += 1;
  current.costMicros = addCost(current.costMicros, frame.costMicros);
  if (stepKind(frame) !== null) {
    if (frame.phase === "request" && current.request === null) {
      current.request = frame;
    } else if (frame.phase !== "request" && current.response === null) {
      current.response = frame;
    }
  }
  const decision = decisionOf(frame);
  if (decision !== null) current.decision = decision;
}

function fold(
  frames: readonly RunFrame[],
  opens: (frame: RunFrame, index: number) => TranscriptEntryKind | null,
): TranscriptFold[] {
  const out: TranscriptFold[] = [];
  let current: TranscriptFold | null = null;
  frames.forEach((frame, index) => {
    const kind = opens(frame, index);
    if (kind !== null || current === null) {
      current = open(frame, kind ?? "frame");
      out.push(current);
      return;
    }
    absorb(current, frame);
  });
  return out;
}

/**
 * Does `frame` close the step `current` opened — the response half of the same
 * exchange? Two halves pair on call id where the producer records one, and on
 * adjacency within the step kind where it does not (a wrapped session). A
 * step that already has its response is closed: the next response of the same
 * kind is a new step.
 */
function closesStep(current: TranscriptFold, frame: RunFrame): boolean {
  if (current.request === null || current.response !== null) return false;
  if (frame.phase !== "response") return false;
  if (stepKind(frame) !== stepKind(current.request)) return false;
  const openId = current.request.identity.callId;
  const closeId = frame.identity.callId;
  if (openId !== null || closeId !== null) return openId === closeId;
  return true;
}

/**
 * The `steps` transcript: one entry per model call and per tool call, request
 * and response folded together, with every other frame folding into the step
 * before it.
 *
 * A step is two frames wherever the producer writes two — the write-ahead
 * intention and the terminal receipt — so the entry carries what the call was
 * made with and what it came back with. Folding them separately, as this did
 * before, showed one tool call as two entries, each with half the exchange.
 */
function foldSteps(frames: readonly RunFrame[]): TranscriptFold[] {
  const out: TranscriptFold[] = [];
  let current: TranscriptFold | null = null;
  for (const frame of frames) {
    if (current !== null && closesStep(current, frame)) {
      absorb(current, frame);
      continue;
    }
    const kind = stepKind(frame);
    if (kind !== null || current === null) {
      current = open(frame, kind ?? "frame");
      out.push(current);
      continue;
    }
    absorb(current, frame);
  }
  return out;
}

/**
 * The transcript at a zoom level. `everything` is one entry per frame, so the
 * two halves of a step are two entries, each with its own body. `steps` is one
 * entry per model call and per tool call, request and response folded
 * together. `turns` opens an entry at every `turn_start` frame, or wherever
 * the turn index changes when the recording carries no turn boundaries; a run
 * with neither is one turn.
 */
export function foldTranscript(
  frames: readonly RunFrame[],
  zoom: TranscriptZoom,
): TranscriptFold[] {
  if (frames.length === 0) return [];
  switch (zoom) {
    case "everything":
      return fold(
        frames,
        (frame) =>
          stepKind(frame) ??
          (POLICY_TYPES.has(frame.type) ? "policy" : "frame"),
      );
    case "steps":
      return foldSteps(frames);
    case "turns": {
      const hasBoundaries = frames.some((frame) =>
        TURN_OPENERS.has(frame.type),
      );
      let lastTurn: number | null = null;
      return fold(frames, (frame, index) => {
        if (hasBoundaries) {
          return TURN_OPENERS.has(frame.type) || index === 0 ? "turn" : null;
        }
        const turn = frame.turnIndex;
        if (index === 0) {
          lastTurn = turn;
          return "turn";
        }
        if (turn === null) return null;
        // Frames before the first indexed frame belong to the first turn.
        const opensTurn = lastTurn !== null && turn !== lastTurn;
        lastTurn = turn;
        return opensTurn ? "turn" : null;
      });
    }
  }
}

/**
 * The turn each frame belongs to, 1-based, in frame order: the grouping the
 * transcript draws its turns from, whatever zoom the entries were read at.
 *
 * A recording with `turn_start` frames counts them, and a frame recorded
 * before the first one (the agent starting, the context it was handed) is in
 * no turn and answers null. A recording without them follows the `turns`
 * fold: a new turn wherever the turn index changes, and every frame in one.
 */
export function turnOrdinals(frames: readonly RunFrame[]): (number | null)[] {
  if (frames.some((frame) => TURN_OPENERS.has(frame.type))) {
    let turn = 0;
    return frames.map((frame) => {
      if (TURN_OPENERS.has(frame.type)) turn += 1;
      return turn === 0 ? null : turn;
    });
  }
  const out: (number | null)[] = [];
  foldTranscript(frames, "turns").forEach((fold, index) => {
    for (let i = 0; i < fold.frames; i += 1) out.push(index + 1);
  });
  return out;
}
