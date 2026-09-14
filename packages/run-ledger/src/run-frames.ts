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
import type { Redaction } from "@oxagen/tacho";

/** What a frame did, as far as its receipt says. Null where it says nothing. */
export interface FrameIdentity {
  tool: string | null;
  toolStatus: string | null;
  model: string | null;
  policy: string | null;
  verdict: string | null;
  contextRows: number | null;
}

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
  identity: FrameIdentity;
}

const NO_IDENTITY: FrameIdentity = {
  tool: null,
  toolStatus: null,
  model: null,
  policy: null,
  verdict: null,
  contextRows: null,
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
    case "model.call_completed": {
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
    case "model.call_completed": {
      const provider = field(p, "provider");
      const model = field(p, "model");
      return {
        ...NO_IDENTITY,
        model: provider && model ? `${provider}/${model}` : model,
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
export type TranscriptEntryKind = "turn" | "model_call" | "tool_call" | "frame";

/** One transcript entry before its text is attached. */
export interface TranscriptFold {
  /** The frame that opens the entry. */
  opening: RunFrame;
  endSeq: string;
  kind: TranscriptEntryKind;
  frames: number;
  /** Summed cost records of the folded frames; null when none carried one. */
  costMicros: number | null;
}

const MODEL_TYPES: ReadonlySet<string> = new Set([
  "model.call_completed",
  "llm_call",
  "model.request",
  "model.response",
]);
const TOOL_TYPES: ReadonlySet<string> = new Set([
  "tool.call_completed",
  "tool_call",
  "tool_requested",
]);
const TURN_OPENERS: ReadonlySet<string> = new Set(["turn_start"]);

export function stepKind(frame: RunFrame): "model_call" | "tool_call" | null {
  if (MODEL_TYPES.has(frame.type)) return "model_call";
  if (TOOL_TYPES.has(frame.type)) return "tool_call";
  return null;
}

function addCost(sum: number | null, cost: number | null): number | null {
  if (cost === null) return sum;
  return (sum ?? 0) + cost;
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
      current = {
        opening: frame,
        endSeq: frame.seq,
        kind: kind ?? "frame",
        frames: 1,
        costMicros: frame.costMicros,
      };
      out.push(current);
      return;
    }
    current.endSeq = frame.seq;
    current.frames += 1;
    current.costMicros = addCost(current.costMicros, frame.costMicros);
  });
  return out;
}

/**
 * The transcript at a zoom level. `everything` is one entry per frame.
 * `steps` opens an entry at every model call and tool call; frames before
 * the first step fold into a leading `frame` entry. `turns` opens an entry
 * at every `turn_start` frame, or wherever the turn index changes when the
 * recording carries no turn boundaries; a run with neither is one turn.
 */
export function foldTranscript(
  frames: readonly RunFrame[],
  zoom: TranscriptZoom,
): TranscriptFold[] {
  if (frames.length === 0) return [];
  switch (zoom) {
    case "everything":
      return fold(frames, (frame) => stepKind(frame) ?? "frame");
    case "steps":
      return fold(frames, (frame) => stepKind(frame));
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
