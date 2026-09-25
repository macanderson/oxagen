/**
 * One frame shape for a run from either store (Mission Control spec §8.2;
 * ADR-058), and the pure reads over it: what each frame is to a transcript,
 * the turn it falls in, and the bisect alignment (§8.4). The fold that groups
 * frames into steps and turns is `transcript-steps.ts` (§14, ADR-182).
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
 * names.
 */
import {
  MODEL_CALL_EVENT_TYPES,
  type RunStepKind,
  stepKindOfEventType,
  TOOL_CALL_EVENT_TYPES,
} from "./event-payload-registry";
import type { AttemptEventReadRecord } from "./run-store";
import type { FrameBodyColumns } from "./frame-body";
import {
  tachoFramePhase,
  tachoFrameSummary,
  tachoKind,
  tachoStage,
} from "./tacho-kinds";
import {
  bodyIsPartial,
  isTranscriptKind,
  countsLlmCallUsage,
  countsLlmCallSplit,
  LLM_CALL_DUPLICATE_OF_ATTR,
  llmCallKeys,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
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
  /**
   * Who made the decision the frame records, in the envelope's
   * `policy_source` words: `bundle` and `kernel` are Oxagen policy, `human`
   * is an operator, `harness` and `managed_settings` are the agent's own
   * harness checking itself. Absent or null where the frame names none.
   */
  policySource?: string | null;
  verdict: string | null;
  contextRows: number | null;
  /**
   * The call the frame belongs to (`tool_call_id`, `model_call_id`), so the
   * two halves of one exchange pair on identity and not on adjacency. A
   * wrapped session's tool rows carry the harness's `tool_use_id`. Null where
   * the producer records none, and those pair on adjacency within the step
   * kind instead.
   */
  callId: string | null;
  /**
   * What a tool call acts on, as the gate recorded it: the command, path or
   * URL from the body's `tool_target`. Absent where the frame names none.
   */
  target?: string | null;
  /**
   * The reasoning effort the harness ran a model call at (`low`, `medium`,
   * `high`), as a wrapped session's frame recorded it. Absent where it
   * recorded none; the ledger records none.
   */
  effort?: string;
  /**
   * The approval a tool call's receipt says it waits on (`apr_…`), as the
   * in-app assistant records a parked call. Absent where the receipt names
   * none.
   */
  approvalId?: string;
}

/**
 * Which half of an exchange the frame records. A step is one request and one
 * response; a producer that appends a single terminal receipt for the whole
 * exchange records `single`, and its body is the result (see `TranscriptFold`).
 */
export type FramePhase = "request" | "response" | "single";

export interface FrameUsage {
  inputUncached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
}

export function addFrameUsage(
  a: FrameUsage | null | undefined,
  b: FrameUsage | null | undefined,
): FrameUsage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const sum = (x: number | null, y: number | null) =>
    x === null ? y : y === null ? x : x + y;
  return {
    inputUncached: sum(a.inputUncached, b.inputUncached),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    output: sum(a.output, b.output),
    reasoning: sum(a.reasoning, b.reasoning),
  };
}

function usageFrom(body: unknown, ledger = false): FrameUsage | null {
  const count = (key: string) => {
    const value = numberField(body, key);
    return value !== null && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  };
  const input = count("input_tokens");
  const cacheRead = count(ledger ? "cached_input_tokens" : "cache_read_tokens");
  const usage = {
    inputUncached:
      ledger && input !== null && cacheRead !== null
        ? Math.max(0, input - cacheRead)
        : input,
    cacheRead,
    cacheWrite: count("cache_creation_tokens"),
    output: count("output_tokens"),
    reasoning: count("thinking_tokens"),
  };
  return Object.values(usage).every((value) => value === null) ? null : usage;
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
  /** Which half of its exchange the frame records. */
  phase: FramePhase;
  identity: FrameIdentity;
  /**
   * What the producer timed about the call, when it timed anything. The
   * recorded stream carries no clock, so a reassembly's time to first token
   * and wall time come from here (tacho `ttft_ms`, `api_duration_ms`).
   */
  timing: FrameTiming;
  usage?: FrameUsage | null;
  usageObserved?: boolean;
  /**
   * The subagent chain the frame was recorded on. Absent on the run's own
   * chain (and on every ledger frame). A subagent records on a chain of its
   * own with its own dense `seq`, so a frame of a run that reads its
   * subagents is named by this and its `seq` together, never by `seq` alone.
   */
  chain?: FrameChain;
  /**
   * On a `subagent_start`: the subagent it spawned, so a reader can put that
   * subagent's chain where it began.
   */
  spawn?: FrameSpawn;
  /**
   * On a wrapped `llm_call`: the source the host sealed this call from first
   * when this row is a later sighting of it (`oxagen.llm_call_duplicate_of`),
   * and the ids it joins sightings on. A later sighting's usage and cost are
   * not counted; the first sighting's are.
   */
  llmCall?: FrameLlmCall;
}

/** A subagent chain's place in its run. */
export interface FrameChain {
  sessionUuid: string;
  /** The chain that spawned this one. */
  parentSessionUuid: string | null;
  subagentId: string | null;
  subagentType: string | null;
  /** The parent's tool call that spawned the subagent. */
  spawnToolUseId: string | null;
}

/** The subagent a `subagent_start` frame records. */
export interface FrameSpawn {
  subagentId: string | null;
  toolUseId: string | null;
}

/** A wrapped model call's sighting facts. */
export interface FrameLlmCall {
  /** Null on a first sighting. */
  duplicateOf: string | null;
  /** `request:<id>`, `message:<id>`: the keys the host's ledger joins sightings on. */
  keys: string[];
  source: string | null;
  /**
   * The body holds one half of the exchange, and the proxy marked the other
   * missing (`bodyIsPartial`). The seal counts such a frame as missing its
   * body.
   */
  partial: boolean;
}

/** What a frame's receipt timed. Null where it timed nothing. */
export interface FrameTiming {
  ttftMs: number | null;
  durationMs: number | null;
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
    case "context.instructions_applied": {
      const provider = field(p, "provider");
      const outcome = field(p, "outcome");
      if (provider && outcome) return `${provider} ${outcome}`;
      return outcome ?? event.eventType;
    }
    case "verification.goal_verdict": {
      const round = field(p, "round");
      const verdict = goalVerdictOf(p);
      return round && verdict ? `round ${round} ${verdict}` : event.eventType;
    }
    case "context.history_summarized": {
      const outcome = field(p, "outcome");
      const covered = field(p, "covered_message_count");
      if (outcome && covered) return `history summary ${outcome} (${covered})`;
      return outcome ? `history summary ${outcome}` : event.eventType;
    }
    case "steering.manifest": {
      const included = field(p, "included");
      const cut = field(p, "cut");
      return included && cut
        ? `included=${included} cut=${cut}`
        : event.eventType;
    }
    default:
      // Both spellings of each call, and both spellings of the tool's name:
      // the ledger's own event calls it `capability_name`, the assistant's
      // engine event calls it `tool_name`. Read through the registry rather
      // than another literal case, because a summary that falls through to
      // the raw event type is what the transcript showed for every run the
      // assistant recorded.
      switch (ledgerStepKind(event.eventType)) {
        case "model_call": {
          const provider = field(p, "provider");
          const model = field(p, "model");
          return provider && model ? `${provider}/${model}` : event.eventType;
        }
        case "tool_call": {
          const tool = toolNameOf(p);
          const outcome = field(p, "outcome");
          // A parked call names the approval it waits on as a third word
          // (`create_workspace parked apr_…`), so the Run page can pair the
          // receipt with that approval's card by id rather than by instant.
          const approval = field(p, "approval_public_id");
          if (tool && outcome && approval && outcome === "parked")
            return `${tool} ${outcome} ${approval}`;
          if (tool && outcome) return `${tool} ${outcome}`;
          // An intention has no outcome by design — it is the frame that says
          // a call is about to happen — so its tool name is the whole truth
          // about it, and a paired step takes its label from it. A RECEIPT
          // with no outcome is malformed, and falls through to its bare type
          // rather than reading as a call that did something.
          return tool && isIntention(event.eventType) ? tool : event.eventType;
        }
        default:
          return event.eventType;
      }
  }
}

/**
 * The two write-ahead intentions and the step each opens.
 *
 * The registry gives a `step` only to the frame that COMPLETES a call, because
 * counting an intention there would report every call twice. A transcript asks
 * which frame OPENS the exchange, and that is the intention — it carries the
 * request. Naming them here keeps both answers right without widening the
 * registry and double-counting every run's steps.
 */
const INTENTION_STEP_KIND: Readonly<Record<string, RunStepKind>> = {
  "model.engine_call_started": "model_call",
  "tool.engine_call_started": "tool_call",
};

/** The step an event belongs to, the intention that opens it included. */
function ledgerStepKind(eventType: string): RunStepKind | null {
  return (
    stepKindOfEventType(eventType) ?? INTENTION_STEP_KIND[eventType] ?? null
  );
}

/** Is this the write-ahead frame of a call, rather than its receipt? */
function isIntention(eventType: string): boolean {
  return Object.hasOwn(INTENTION_STEP_KIND, eventType);
}

/** The intentions that open a step of `kind`, read off the table above. */
function intentionsOpening(kind: RunStepKind): string[] {
  return Object.entries(INTENTION_STEP_KIND)
    .filter(([, step]) => step === kind)
    .map(([type]) => type);
}

/**
 * A goal round's verdict in the words the transcript prints: `met` or
 * `not_met`. Null when the payload carries no boolean, which a strict schema
 * refuses at append, so a reader never guesses a verdict.
 */
function goalVerdictOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const met = (payload as Record<string, unknown>).met;
  if (typeof met !== "boolean") return null;
  return met ? "met" : "not_met";
}

/** The called tool, under either payload's name for it. */
function toolNameOf(payload: unknown): string | null {
  return field(payload, "capability_name") ?? field(payload, "tool_name");
}

function ledgerIdentity(event: AttemptEventReadRecord): FrameIdentity {
  const p = event.payload;
  const step = ledgerStepKind(event.eventType);
  // The call id is what pairs an intention with its receipt (`foldTranscript`,
  // transcript-steps.ts).
  // Only the engine's own events record one; a submitted receipt stands for a
  // whole exchange and needs no pairing, so its null is correct.
  if (step === "tool_call") {
    const approval = field(p, "approval_public_id");
    return {
      ...NO_IDENTITY,
      tool: toolNameOf(p),
      toolStatus: field(p, "outcome"),
      callId: field(p, "tool_call_id"),
      ...(approval === null ? {} : { approvalId: approval }),
    };
  }
  if (step === "model_call") {
    const provider = field(p, "provider");
    const model = field(p, "model");
    return {
      ...NO_IDENTITY,
      model: provider && model ? `${provider}/${model}` : model,
      callId: field(p, "model_call_id"),
    };
  }
  switch (event.eventType) {
    case "tool.approval_recorded":
      return { ...NO_IDENTITY, policy: field(p, "decision") };
    case "verification.completed":
      return { ...NO_IDENTITY, verdict: field(p, "verdict") };
    case "verification.goal_verdict":
      return { ...NO_IDENTITY, verdict: goalVerdictOf(p) };
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
    usage:
      stepKindOfEventType(event.eventType) === "model_call"
        ? usageFrom(event.payload, true)
        : null,
    seq: event.runSeq,
    type: event.eventType,
    stage: event.stage,
    observedAt: event.observedAt,
    digest: event.eventDigest,
    summary: ledgerFrameSummary(event),
    body: event.body,
    costMicros: null,
    // A turn index only travels on the ledger's own model event; the
    // assistant's engine event has no such field, so an assistant run's
    // `turns` zoom falls back to the boundaries rather than to an index.
    turnIndex:
      stepKindOfEventType(event.eventType) === "model_call"
        ? numberField(event.payload, "turn_index")
        : null,
    phase: ledgerPhase(event.eventType),
    identity: ledgerIdentity(event),
    // The ledger's receipts carry no call timing of their own; a reassembly
    // on a ledger frame times itself from the two frames of its step.
    timing: {
      ttftMs: numberField(event.payload, "ttft_ms"),
      durationMs: numberField(event.payload, "duration_ms"),
    },
  };
}

// ── Wrapped (tacho) ─────────────────────────────────────────────────────────

/** The `tacho_events` columns the projection reads, as the telemetry seam returns them. */
export interface TachoFrameRowLike {
  body?: string;
  source?: string;
  fidelity?: string;
  attrs?: Record<string, string>;
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
  /** The tool_use_id the producer recorded; empty when the kind carries none. */
  toolUseId: string;
  model: string;
  provider: string;
  policyDecision: string;
  costUsdMicros: number | null;
  turnSeq: number | null;
  /** Milliseconds to the first token the provider sent; null when untimed. */
  ttftMs?: number | null;
  /** The provider call's wall time; null when untimed. */
  apiDurationMs?: number | null;
  /** The reasoning effort the call ran at; empty when unrecorded. */
  effort?: string;
  /** The chain the row was recorded on; set by a read across a run's chains. */
  sessionUuid?: string;
  rootSessionUuid?: string;
  parentSessionUuid?: string | null;
  subagentId?: string;
  subagentType?: string;
  spawnToolUseId?: string;
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

/**
 * The chain a row was recorded on, when it is a subagent's, and the subagent
 * a `subagent_start` spawned. A row read from one session's chain names no
 * chain and adds neither.
 */
function tachoChainFacts(
  row: TachoFrameRowLike,
  payload: unknown,
): Pick<RunFrame, "chain" | "spawn"> {
  const out: Pick<RunFrame, "chain" | "spawn"> = {};
  if (
    row.sessionUuid !== undefined &&
    row.rootSessionUuid !== undefined &&
    row.sessionUuid !== row.rootSessionUuid
  ) {
    out.chain = {
      sessionUuid: row.sessionUuid,
      parentSessionUuid: row.parentSessionUuid ?? null,
      subagentId: blank(row.subagentId ?? ""),
      subagentType: blank(row.subagentType ?? ""),
      spawnToolUseId: blank(row.spawnToolUseId ?? ""),
    };
  }
  if (row.kind === "subagent_start") {
    const bodyToolUseId = field(payload, "tool_use_id");
    out.spawn = {
      subagentId: blank(row.attrs?.["hook.agent_id"] ?? ""),
      toolUseId: blank(row.toolUseId) ?? bodyToolUseId,
    };
  }
  return out;
}

/** The longest effort label a frame carries; the column is a short enum. */
const EFFORT_MAX = 32;
/** The longest `tool_target` a frame carries into the transcript. */
const TARGET_MAX = 400;

/** A `tacho_events` row as a run frame. */
export function tachoFrame(stored: TachoFrameRowLike): RunFrame {
  let payload: unknown = null;
  try {
    payload = stored.body ? JSON.parse(stored.body) : null;
  } catch {
    /* Legacy malformed metadata carries no usage. */
  }
  const kind = tachoKind(stored, field(payload, "policy_source"));
  const row = kind === stored.kind ? stored : { ...stored, kind };
  const target = field(payload, "tool_target");
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
  const usageObserved =
    row.kind === "llm_call" &&
    row.source === "collector" &&
    row.fidelity === "proxy" &&
    row.attrs?.[TACHO_METERING_ATTR] === TACHO_METERING_OBSERVED;
  const usageSource = {
    kind: row.kind,
    source: row.source ?? "",
    attrs: row.attrs ?? {},
  };
  const counted = countsLlmCallUsage(usageSource);
  const split = countsLlmCallSplit(usageSource);
  // A later sighting of a call the host already sealed from another source.
  // Its tokens are not counted (`countsLlmCallUsage`), and neither is its
  // cost: carrying the cost here priced the call twice on every transcript
  // entry and cumulative sum that read it.
  const duplicateOf =
    row.kind === "llm_call"
      ? (row.attrs?.[LLM_CALL_DUPLICATE_OF_ATTR] ?? null)
      : null;
  let usage = usageObserved || counted || split ? usageFrom(payload) : null;
  if (usage) {
    if (!usageObserved && !counted) {
      usage.inputUncached = null;
      usage.cacheRead = null;
      usage.cacheWrite = null;
      usage.output = null;
    }
    if (!usageObserved && !split) usage.reasoning = null;
    if (Object.values(usage).every((value) => value === null)) usage = null;
  }
  return {
    usage,
    usageObserved,
    seq: String(row.seq),
    type: row.kind,
    stage: tachoStage(row.kind),
    observedAt: tachoTimestamp(row.ts),
    digest: row.hash,
    summary: tachoFrameSummary(row),
    body,
    costMicros: duplicateOf === null ? row.costUsdMicros : null,
    turnIndex: row.turnSeq,
    phase: tachoFramePhase(row.kind, payload),
    ...tachoChainFacts(row, payload),
    ...(row.kind === "llm_call"
      ? {
          llmCall: {
            duplicateOf,
            keys:
              typeof payload === "object" && payload !== null
                ? llmCallKeys(payload as Record<string, unknown>).ids
                : [],
            source: blank(row.source ?? ""),
            partial: bodyIsPartial(row.attrs),
          },
        }
      : {}),
    identity: {
      tool: blank(row.toolName),
      toolStatus: blank(row.toolStatus),
      model:
        model === null
          ? null
          : row.provider
            ? `${row.provider}/${model}`
            : model,
      // An operator command records the command as its decision: the host's
      // allow or deny is how it applied a pause, not what the person chose.
      policy:
        row.kind === COMMAND_APPLIED
          ? (blank(row.attrs?.["command.name"] ?? "") ??
            blank(row.policyDecision))
          : blank(row.policyDecision),
      policySource: field(payload, "policy_source"),
      verdict: null,
      contextRows: null,
      // The producer's tool_use_id: the step fold gathers every frame of one
      // call on it, so parallel wrapped calls (start A, start B, complete A,
      // complete B) pair correctly. Empty for kinds that carry no call id;
      // those fall back to adjacency (`transcript-steps.ts`).
      callId: blank(row.toolUseId),
      ...(target === null || target === ""
        ? {}
        : { target: target.slice(0, TARGET_MAX) }),
      ...(row.effort === undefined || row.effort === ""
        ? {}
        : { effort: row.effort.slice(0, EFFORT_MAX) }),
    },
    timing: {
      ttftMs: row.ttftMs ?? null,
      durationMs: row.apiDurationMs ?? null,
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

// ── Transcript vocabulary ───────────────────────────────────────────────────
//
// What a single frame is, as the transcript reads it: which step it belongs
// to, which chips it answers, and which turn it falls in. The fold that groups
// frames into steps and turns is `transcript-steps.ts` (ADR-182).

// The chip vocabulary is the leaf package's (`@oxagen/tacho`), so the contract
// that publishes it as an enum and this projection that derives it read one
// list. Re-exported here so a caller over frames has one import site.
export { isTranscriptKind, TRANSCRIPT_KINDS, type TranscriptKind };

/** An operator's command as the host applied it. */
export const COMMAND_APPLIED = "oxagen:command_applied";

/**
 * Frames that record a decision a rule or a person made about a call, or an
 * operator's command to the run (`oxagen:command_applied`).
 */
export const POLICY_TYPES: ReadonlySet<string> = new Set([
  "tool.approval_recorded",
  COMMAND_APPLIED,
  "policy_decision",
  "approval_request",
  "approval_decision",
  "token_issued",
  "token_use",
  "token_denied",
]);
/** Frames that record what was pulled into the model's context. */
export const RECALL_TYPES: ReadonlySet<string> = new Set([
  "context.frames_selected",
  "context.instructions_applied",
  "context.history_summarized",
  "context.assembled",
  // What the assembler put in front of a wrapped agent at its start, and
  // what it cut (ADR-093).
  "steering.manifest",
]);
/**
 * A wrapped chain's own integrity frames: the signed checkpoint over the
 * chain so far, and the gap it records where frames were lost. A ledger
 * attempt's counterpart is its terminal-stage event, read by stage.
 */
const SEAL_TYPES: ReadonlySet<string> = new Set([
  "checkpoint",
  "telemetry_gap",
]);
/**
 * Tool outcomes that record a call that did not do what it was asked to.
 * `rejected` is tacho's word for a call the harness refused
 * (`packages/tacho/src/envelope.ts`: ok, error, rejected, cancelled), so the
 * errors chip keeps it (#3370).
 */
export const FAILED_OUTCOMES: ReadonlySet<string> = new Set([
  "failed",
  "denied",
  "cancelled",
  "error",
  "timeout",
  "refused",
  "rejected",
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
  // A wrapped run's prompt is the `turn_start` its operator typed, not a model
  // request: tacho records the harness's hooks and never a `model.request`.
  // A subagent's own `turn_start` is the prompt its parent wrote, so it is not
  // counted. Nor is the transcript's or OTel's `oxagen:message` copy of the
  // same prompt, which would count each prompt two or three times.
  if (opensRunTurn(frame)) kinds.add("prompt");
  // A model call that reasoned. The count is the provider's own report, so a
  // call whose text was not kept still answers the chip.
  if ((frame.usage?.reasoning ?? 0) > 0) kinds.add("thinking");
  if (TOOL_TYPES.has(frame.type)) kinds.add("tools");
  if (POLICY_TYPES.has(frame.type)) kinds.add("policy");
  if (RECALL_TYPES.has(frame.type)) kinds.add("recall");
  if (frame.costMicros !== null) kinds.add("usage");
  if (SEAL_TYPES.has(frame.type) || frame.stage === "terminal") {
    kinds.add("seal");
  }
  const status = frame.identity.toolStatus;
  if (status !== null && FAILED_OUTCOMES.has(status)) kinds.add("errors");
  if (frame.type === "error" || frame.type.endsWith(".error")) {
    kinds.add("errors");
  }
  return [...kinds];
}

/**
 * The frame types that make a frame one half of a model call or a tool call.
 * The ledger's own names come from the registry, so both spellings of each
 * call event are covered: the in-app assistant writes
 * `model.engine_call_completed` and `tool.engine_call_completed`. The
 * wrapped-session names are added beside them: a tacho recording is not in
 * the ledger's registry and never will be.
 *
 * The write-ahead intentions are here too, and are NOT in the registry's step
 * sets. The two sets answer different questions. The registry's answers "which
 * frame completes a call", and counting an intention there would report every
 * call twice. This one answers "which frame is part of an exchange", and the
 * intention is exactly that: it carries the request the step was made with.
 */
const MODEL_TYPES: ReadonlySet<string> = new Set([
  ...MODEL_CALL_EVENT_TYPES,
  ...intentionsOpening("model_call"),
  "llm_call",
  "model.request",
  "model.response",
]);
const TOOL_TYPES: ReadonlySet<string> = new Set([
  ...TOOL_CALL_EVENT_TYPES,
  ...intentionsOpening("tool_call"),
  "tool_call",
  "tool_requested",
]);
const TURN_OPENERS: ReadonlySet<string> = new Set(["turn_start"]);

/**
 * Whether `frame` opens one of the run's turns. A subagent's own
 * `turn_start` is the prompt its parent handed it, inside the parent's turn:
 * it opens no turn of the run, so splicing a subagent's chain in never
 * renumbers the turns a person typed.
 */
export function opensRunTurn(frame: RunFrame): boolean {
  return TURN_OPENERS.has(frame.type) && frame.chain === undefined;
}

export function stepKind(frame: RunFrame): "model_call" | "tool_call" | null {
  if (MODEL_TYPES.has(frame.type)) return "model_call";
  if (TOOL_TYPES.has(frame.type)) return "tool_call";
  return null;
}

/**
 * The turn each frame belongs to, 1-based, in frame order: the grouping the
 * transcript folds its turns from, whatever zoom the entries are read at.
 *
 * A recording with `turn_start` frames counts them, and a frame recorded
 * before the first one (the agent starting, the context it was handed) is in
 * no turn and answers null. A recording without them opens a turn at its
 * first frame and wherever the recorded turn index changes after that, so
 * every frame is in one. A subagent numbers its own turns, and those are not
 * the run's: its frames stay in the turn they were spawned in.
 */
export function turnOrdinals(frames: readonly RunFrame[]): (number | null)[] {
  if (frames.some(opensRunTurn)) {
    let turn = 0;
    return frames.map((frame) => {
      if (opensRunTurn(frame)) turn += 1;
      return turn === 0 ? null : turn;
    });
  }
  let turn = 0;
  let lastIndex: number | null = null;
  return frames.map((frame, index) => {
    if (index === 0) {
      turn = 1;
      lastIndex = frame.turnIndex;
      return turn;
    }
    if (frame.chain !== undefined || frame.turnIndex === null) return turn;
    // Frames before the first indexed frame belong to the first turn.
    if (lastIndex !== null && frame.turnIndex !== lastIndex) turn += 1;
    lastIndex = frame.turnIndex;
    return turn;
  });
}

// ── Subagent chains ─────────────────────────────────────────────────────────

/**
 * The run's own frames with every subagent chain spliced in where it was
 * spawned.
 *
 * A wrapped agent's subagent records on a chain of its own (`chain` on each of
 * its frames), numbered from 0 like the root's. The run is the root and every
 * chain under it, so a reader of the run reads them as one sequence: each
 * chain is placed, whole and in its own order, directly after the
 * `subagent_start` that spawned it (matched on the spawning tool call's id,
 * then on the subagent id, trying the chain that began first when two could
 * answer one spawn), and a chain that spawned subagents of its own has theirs
 * placed the same way inside it.
 *
 * A chain is kept whole rather than interleaved by timestamp because the
 * transcript pairs a request with its result by call id, and by adjacency
 * where a producer recorded none. Interleaving a subagent's frames with its
 * parent's by wall clock puts the parent's frames between a subagent's
 * request and its result, which is where adjacency pairing breaks.
 *
 * A chain whose spawn was not recorded (a `subagent_start` lost, or a harness
 * that records none) goes before the first frame of its parent that was
 * observed after the chain's own first frame, and at the end of its parent
 * when none was. A chain whose parent chain is not among `children` is placed
 * under the root, so no recorded frame is ever dropped.
 */
export function spliceSubagentChains(
  root: readonly RunFrame[],
  children: readonly RunFrame[],
): RunFrame[] {
  if (children.length === 0) return [...root];
  const chains = new Map<string, RunFrame[]>();
  for (const frame of children) {
    const id = frame.chain?.sessionUuid;
    if (id === undefined) continue;
    const list = chains.get(id) ?? [];
    list.push(frame);
    chains.set(id, list);
  }
  for (const list of chains.values()) {
    list.sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)));
  }
  const ROOT = "";
  const parentOf = (id: string): string => {
    const parent = chains.get(id)?.[0]?.chain?.parentSessionUuid ?? null;
    return parent !== null && chains.has(parent) && parent !== id
      ? parent
      : ROOT;
  };
  const firstAt = (id: string): number =>
    chains.get(id)?.[0]?.observedAt.getTime() ?? Number.POSITIVE_INFINITY;
  const childrenOf = new Map<string, string[]>();
  for (const id of chains.keys()) {
    const parent = parentOf(id);
    const list = childrenOf.get(parent) ?? [];
    list.push(id);
    childrenOf.set(parent, list);
  }
  // Where two chains could answer one spawn (a subagent resumed under the id
  // it had, with no spawning call recorded), the one that began first is
  // tried first, then the lower session id. The order the store read the
  // chains in is not an order: ClickHouse sorts a UUID by its last eight
  // bytes first. `get_run_turns` places chains by this same rule, so a
  // chain's frames fall in the same turn on the transcript and on the ledger.
  for (const list of childrenOf.values())
    list.sort(
      (a, b) => firstAt(a) - firstAt(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
  const placed = new Set<string>();
  const out: RunFrame[] = [];

  const facts = (id: string): FrameChain | undefined =>
    chains.get(id)?.[0]?.chain;

  /** Which of `candidates` each `subagent_start` in `frames` spawned. */
  const spawnsIn = (
    frames: readonly RunFrame[],
    candidates: readonly string[],
  ): Map<RunFrame, string> => {
    const out = new Map<RunFrame, string>();
    const taken = new Set<string>();
    const match = (
      frame: RunFrame,
      same: (chain: FrameChain, spawn: FrameSpawn) => boolean,
    ): string | undefined =>
      candidates.find((id) => {
        const chain = facts(id);
        return (
          !taken.has(id) &&
          chain !== undefined &&
          frame.spawn !== undefined &&
          same(chain, frame.spawn)
        );
      });
    for (const frame of frames) {
      if (frame.spawn === undefined) continue;
      const hit =
        match(
          frame,
          (chain, spawn) =>
            spawn.toolUseId !== null &&
            chain.spawnToolUseId === spawn.toolUseId,
        ) ??
        match(
          frame,
          (chain, spawn) =>
            spawn.subagentId !== null && chain.subagentId === spawn.subagentId,
        );
      if (hit !== undefined) {
        taken.add(hit);
        out.set(frame, hit);
      }
    }
    return out;
  };

  const emit = (frames: readonly RunFrame[], id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    const candidates = childrenOf.get(id) ?? [];
    const spawns = spawnsIn(frames, candidates);
    const matched = new Set(spawns.values());
    // The chains no frame of this one spawns, placed by when they began.
    const loose = candidates
      .filter((c) => !matched.has(c))
      .sort((a, b) => firstAt(a) - firstAt(b));
    for (const frame of frames) {
      while (
        loose.length > 0 &&
        firstAt(loose[0] as string) < frame.observedAt.getTime()
      ) {
        const next = loose.shift() as string;
        emit(chains.get(next) ?? [], next);
      }
      out.push(frame);
      const child = spawns.get(frame);
      if (child !== undefined) emit(chains.get(child) ?? [], child);
    }
    for (const next of loose) emit(chains.get(next) ?? [], next);
  };

  emit(root, ROOT);
  // A chain a cycle in the recorded parents kept out of every walk above.
  for (const [id, frames] of chains) emit(frames, id);
  return out;
}

/**
 * A frame's name within its run: its `seq` on the run's own chain, and its
 * chain and `seq` on a subagent's. Stable across reads, so a cursor can carry
 * it.
 */
export function frameKey(frame: RunFrame): string {
  return frame.chain === undefined
    ? frame.seq
    : `${frame.chain.sessionUuid}:${frame.seq}`;
}

/** Where a source records a model call's content, richest first. */
const LLM_CALL_BODY_RANK: Readonly<Record<string, number>> = {
  // The proxy keeps the whole response stream: every block of the message.
  collector: 3,
  // The transcript keeps the message as the harness wrote it down.
  transcript: 2,
  hook: 1,
  otel_log: 0,
};

/**
 * The frames a transcript shows, with each model call once.
 *
 * A wrapped session reports one model call from up to three sources, and
 * the host stamps every sighting after the first with
 * `oxagen.llm_call_duplicate_of` (`FrameLlmCall.duplicateOf`). Read as they
 * are, a proxied call drew as two model steps: the proxy's, and the
 * transcript's copy of the same message. So, per call (joined on the
 * request or message id the host's ledger joins on, within one chain):
 *
 *   - a later sighting from another source that carries no body is left
 *     out: the call is already on the page and the copy has nothing to add;
 *   - where both carry a body, the one whose source keeps more of the message
 *     is kept (the proxy's stream over the transcript's text, the transcript
 *     over a hook's or an OTel record's), and the first sighting on a tie;
 *   - the frame left out gives its counted usage and cost to the one kept,
 *     so hiding a copy never hides the spend.
 *
 * A transcript writes one record per content block and the host stamps each
 * block after the first as a duplicate of its own source. Those are the rest
 * of one message, not copies of it: they stay exactly when the message's
 * first block stays, and go when a richer sighting replaced it.
 *
 * A later sighting whose first sighting is not among `frames` stays: it is
 * then the only copy of the call on the page. Nothing else is touched.
 */
export function withoutDuplicateModelCalls(
  frames: readonly RunFrame[],
): RunFrame[] {
  const hidden = new Set<RunFrame>();
  // The frame that first carried each call, and each source's first frame
  // of it, keyed by chain and call id.
  const firstByKey = new Map<string, RunFrame>();
  const sourceHead = new Map<string, RunFrame>();
  const continuations: Array<{ frame: RunFrame; keys: string[] }> = [];
  const chainOf = (frame: RunFrame) => frame.chain?.sessionUuid ?? "";
  const rank = (frame: RunFrame) =>
    LLM_CALL_BODY_RANK[frame.llmCall?.source ?? ""] ?? -1;
  for (const frame of frames) {
    const call = frame.llmCall;
    if (call === undefined || call.keys.length === 0) continue;
    const scoped = call.keys.map((key) => `${chainOf(frame)}|${key}`);
    const bySource = scoped.map((key) => `${key}|${call.source ?? ""}`);
    if (call.duplicateOf !== null && call.duplicateOf === call.source) {
      continuations.push({ frame, keys: bySource });
      continue;
    }
    for (const key of bySource)
      if (!sourceHead.has(key)) sourceHead.set(key, frame);
    if (call.duplicateOf === null) {
      for (const key of scoped)
        if (!firstByKey.has(key)) firstByKey.set(key, frame);
      continue;
    }
    const first = scoped
      .map((key) => firstByKey.get(key))
      .find((found): found is RunFrame => found !== undefined);
    if (first === undefined || hidden.has(first)) continue;
    const keepCopy =
      frame.body.bodyRef !== null &&
      (first.body.bodyRef === null || rank(frame) > rank(first));
    if (!keepCopy) {
      hidden.add(frame);
      continue;
    }
    // The copy is the one worth reading. It takes the call's counted spend,
    // and every key of the call now names it.
    hidden.add(first);
    frame.costMicros = first.costMicros;
    frame.usage = first.usage ?? null;
    frame.usageObserved = first.usageObserved;
    for (const key of scoped) firstByKey.set(key, frame);
  }
  for (const { frame, keys } of continuations) {
    const head = keys
      .map((key) => sourceHead.get(key))
      .find((found): found is RunFrame => found !== undefined);
    if (head !== undefined && hidden.has(head)) hidden.add(frame);
  }
  return hidden.size === 0
    ? [...frames]
    : frames.filter((frame) => !hidden.has(frame));
}
