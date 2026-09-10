/**
 * The wire this client speaks to `stella-serve` (`STELLA_SERVE_PINNED_VERSION`
 * in `./version.ts`).
 *
 * Two sources, and the split between them is the rule of this file:
 *
 * - `./generated/serveframe.d.ts` is Stella's own export of what the server
 *   SENDS (every frame, the whole `AgentEvent` graph, and the payload types the
 *   two directions share). It is copied, not written, and this file re-exports
 *   from it rather than restating a type it already has. A restated type is a
 *   second copy to drift.
 * - What the server ACCEPTS — the reverse-request answers and the request
 *   bodies of every route — has no generated TypeScript. Those are written here
 *   by hand, each against the `$defs` entry of `serveinbound.schema.json` or the
 *   Rust struct in `stella-serve/src/routes.rs` it mirrors, and
 *   `wire.pin.test.ts` holds the hand-written ones to the schema's `required`
 *   lists whenever the Stella checkout is on disk.
 *
 * Field names are the server's `snake_case`, untranslated, so a body can be
 * read beside the schema without a mapping table in between.
 */

import type {
  EngineOverrides as GeneratedEngineOverrides,
  ProviderDeltaIn as GeneratedProviderDeltaIn,
  RequeryResultIn as GeneratedRequeryResultIn,
  ToolResultIn as GeneratedToolResultIn,
  BudgetMode,
  CompletionMessage,
  CompletionResult,
  GenerationParams,
  ModelCallRole,
  ProviderDelta,
  ProviderErrorWire,
  ReasoningEffort,
  ReplayTruncated,
  StellaWireFrame,
  ToolOutput,
  ToolSchema,
} from "./generated/serveframe";

// ── what the server sends, re-exported from the generated file ──────────────

export type {
  AgentEvent,
  Attachment,
  AttachmentSource,
  BudgetMode,
  CompletionMessage,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  ErrorClass,
  FinishReason,
  GenerationParams,
  KnownTypeTag,
  MessageRole,
  ModelCallRole,
  PartialUsage,
  ProviderDelta,
  ProviderErrorWire,
  ReasoningEffort,
  ReplayTruncated,
  RequerySignal,
  ServerFrame,
  StellaSseFrame,
  StellaWireFrame,
  ToolCall,
  ToolOutput,
  ToolResult,
  ToolSchema,
  TurnOutcomeWire,
} from "./generated/serveframe";

/**
 * `ModelCallRole` as a host should read it: the generated union names every
 * role this server version emits, and a newer server may add one. A frame
 * carrying a role this client has never seen still parses; a `switch` over
 * roles keeps a default arm.
 */
export type ModelCallRoleWire = ModelCallRole | (string & {});

/** The `provider_request` frame, with `role` widened per `ModelCallRoleWire`. */
export type ProviderRequestFrame = Omit<
  Extract<StellaWireFrame, { type: "provider_request" }>,
  "role"
> & { role: ModelCallRoleWire };

export type ToolRequestFrame = Extract<
  StellaWireFrame,
  { type: "tool_request" }
>;
export type RequeryRequestFrame = Extract<
  StellaWireFrame,
  { type: "requery_request" }
>;
export type EventFrame = Extract<StellaWireFrame, { type: "event" }>;
export type TurnHeldFrame = Extract<StellaWireFrame, { type: "turn_held" }>;
export type TurnReleasedFrame = Extract<
  StellaWireFrame,
  { type: "turn_released" }
>;
export type TurnCompleteFrame = Extract<
  StellaWireFrame,
  { type: "turn_complete" }
>;
export type { ReplayTruncated as ReplayTruncatedFrame };

// ── what the server accepts: reverse-request answers ────────────────────────
//
// `serveinbound.schema.json` is the authority for these. The generated `.d.ts`
// also prints them, but its printer has two defects at 0.9.411: every inbound
// interface is emitted with a doubled brace (repaired in the local copy, see
// its header), and `ProviderResultIn` is printed as `{request_id}` alone
// because the `status`/`result`/`error` fields are serde-flattened and the
// printer drops flattened enums. So these are written here, and the ones the
// printer does get right are pinned to the generated copies below.

/**
 * `$defs.ToolResultIn` — the body of `POST /v1/turns/{id}/tool-result`.
 * Required: `request_id`, `output`.
 */
export interface ToolResultIn {
  request_id: string;
  output: ToolOutput;
}

/**
 * `$defs.ProviderResultIn` — the body of `POST /v1/turns/{id}/provider-result`.
 * Required: `request_id`, then `status: "ok"` with `result` or
 * `status: "error"` with `error`.
 */
export type ProviderResultIn =
  | { request_id: string; status: "ok"; result: CompletionResult }
  | { request_id: string; status: "error"; error: ProviderErrorWire };

/**
 * `$defs.ProviderDeltaIn` — the body of `POST /v1/turns/{id}/provider-delta`.
 * Required: `request_id`, `deltas`. The server refuses an empty `deltas`
 * with a 400, because an empty batch resets no deadline and would let a host
 * believe it had proved liveness.
 */
export interface ProviderDeltaIn {
  request_id: string;
  deltas: ProviderDelta[];
}

/**
 * `$defs.RequeryResultIn` — the body of `POST /v1/turns/{id}/requery-result`.
 * Required: `request_id`. `context: null` is the ordinary answer.
 */
export interface RequeryResultIn {
  request_id: string;
  context?: string | null;
}

/**
 * `$defs.EngineOverrides` — the optional `engine` object on both turn-create
 * routes. No field is required; an unknown field is a 400 (the server uses
 * `deny_unknown_fields`); `max_output_tokens` clamps to 262144 and
 * `temperature` to 2.0, each clamp reported in `TurnCreated.clamped`.
 */
export interface EngineOverrides {
  compaction_budget_tokens?: number | null;
  effort?: ReasoningEffort | null;
  max_output_tokens?: number | null;
  model_timeout_secs?: number | null;
  params?: GenerationParams | null;
  reasoning?: boolean | null;
  summarize_keep_recent?: number | null;
  summarize_overflow?: boolean | null;
  temperature?: number | null;
  tool_result_horizon_steps?: number | null;
}

// The hand-written answers above must say exactly what the generated copies
// say, in both directions. A field added upstream fails here at typecheck,
// before any turn is driven.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
type _ToolResultInPinned = Assert<
  MutuallyAssignable<ToolResultIn, GeneratedToolResultIn>
>;
type _ProviderDeltaInPinned = Assert<
  MutuallyAssignable<ProviderDeltaIn, GeneratedProviderDeltaIn>
>;
type _RequeryResultInPinned = Assert<
  MutuallyAssignable<RequeryResultIn, GeneratedRequeryResultIn>
>;
type _EngineOverridesPinned = Assert<
  MutuallyAssignable<EngineOverrides, GeneratedEngineOverrides>
>;

// ── what the server accepts: route bodies ───────────────────────────────────
//
// None of these are in `serveinbound.schema.json`; each mirrors a
// `#[derive(Deserialize)]` struct in `stella-serve/src/routes.rs` or
// `routes/sessions.rs`, named beside it.

/** `BudgetSpec` in `routes.rs`. `mode` defaults to `"off"` on the server. */
export interface BudgetSpec {
  mode?: BudgetMode;
  turn_limit_usd?: number | null;
  session_limit_usd?: number | null;
}

/** `SessionCreateRequest` in `routes/sessions.rs` — `POST /v1/sessions`. */
export interface CreateSessionRequest {
  /**
   * Message index 0 of every turn in the session, held byte-identical for the
   * session's life. This is the prompt-cache contract: the engine never
   * rewrites it, so each turn reopens the same cached prefix.
   */
  system_prompt: string;
  budget?: BudgetSpec;
}

/** `SessionCreated` in `routes/sessions.rs`. */
export interface SessionCreated {
  session_id: string;
}

/**
 * `RiskLevel` in `stella-protocol/src/contract.rs`. A token the server does
 * not recognise reads as `destructive`, so a misspelt level is the strictest
 * one rather than a lenient one.
 */
export type RiskLevel = "low" | "medium" | "high" | "destructive";

/**
 * `ToolContract` in `stella-protocol/src/contract.rs`, as a host declares one
 * over the wire. `provenance` is always `"declared"` from here: `"builtin"`
 * names a tool compiled into the binary, which a host cannot claim to be.
 * `version` is the contract-shape revision, and 1 is the only one that
 * exists.
 */
export interface ToolContractWire {
  version: 1;
  schema: ToolSchema;
  risk: RiskLevel;
  requires_approval: boolean;
  provenance: "declared";
  output_schema?: unknown;
  events?: string[];
  idempotent?: boolean;
}

/**
 * `WireTool` in `routes.rs`: a full contract, or a bare schema that the server
 * upgrades to an untrusted, high-risk contract. Send contracts; the bare form
 * exists for clients that predate contracts.
 */
export type WireTool = ToolContractWire | ToolSchema;

/** `GoalSpec` in `routes.rs` — a judged multi-round run. */
export interface GoalSpec {
  goal: string;
  max_rounds?: number | null;
  verifier_max_output_tokens?: number | null;
  verifier_transcript_chars?: number | null;
  verifier_provider_id?: string | null;
}

/** `SubAgentsSpec` in `routes.rs`. */
export interface SubAgentsSpec {
  enabled?: boolean;
  pool_limit_usd?: number | null;
  max_steps?: number | null;
  provider_id?: string | null;
}

interface TurnRequestCommon {
  /**
   * Which provider serves this turn's model calls. Every `provider_request`
   * frame echoes it; the host maps it, together with the frame's `role`, to a
   * concrete model. The engine never sees a model name until the host's
   * result carries one.
   */
  provider_id: string;
  tools?: WireTool[];
  /**
   * The acting identity for this turn's tool calls. Opaque to the engine; it
   * reaches the authorisation gate as `Principal::Host(id)`. An omitted
   * principal attributes every call to an anonymous host, so send one.
   */
  principal?: string;
  max_steps?: number;
  /**
   * How long a reverse request may wait for the host's answer, in
   * milliseconds, before the engine treats it as failed. Clamped to one hour;
   * a delta batch on a provider request resets it.
   */
  reverse_request_timeout_ms?: number;
  engine?: EngineOverrides;
  steering_requery?: boolean;
  goal?: GoalSpec;
  sub_agents?: SubAgentsSpec;
}

/** `SessionTurnRequest` in `routes/sessions.rs` — `POST /v1/sessions/{id}/turns`. */
export interface SessionTurnRequest extends TurnRequestCommon {
  /** This turn's new messages, appended to the session's transcript. */
  input: CompletionMessage[];
}

/** `TurnRequest` in `routes.rs` — the stateless `POST /v1/turns`. */
export interface TurnRequest extends TurnRequestCommon {
  /** The whole conversation, system message first. */
  messages: CompletionMessage[];
  budget?: BudgetSpec;
}

/** `ClampedKnob` in `engine_overrides.rs`. */
export interface ClampedKnob {
  knob: string;
  requested: number;
  effective: number;
}

/**
 * `TurnCreated` in `routes.rs`. The server omits `clamped` entirely when no
 * knob was lowered; the client normalises it to an empty array.
 */
export interface TurnCreated {
  turn_id: string;
  clamped: ClampedKnob[];
}

/** `SessionTurnCreated` in `routes/sessions.rs`. */
export interface SessionTurnCreated extends TurnCreated {
  session_id: string;
}

/** `SessionInfo` in `routes/sessions.rs` — `GET /v1/sessions/{id}`. */
export interface SessionView {
  session_id: string;
  turns_completed: number;
  turns_aborted: number;
  cost_usd: number;
  /** The running turn's id, which a reconnecting host rejoins, or `null`. */
  live_turn: string | null;
  /** Whether the live turn is paused and waiting on `/resume`. */
  held: boolean;
  /** The retained transcript, compaction rewrites included. */
  messages: CompletionMessage[];
}

/**
 * `SessionDeleted` in `routes/sessions.rs`. `checkpoint` appears only when the
 * server failed to discard the session's checkpoint, which does not change
 * `status`.
 */
export interface SessionDeleted {
  status: "deleted";
  checkpoint?: "retained";
}

/** `SteerIn` in `routes.rs` — `POST /v1/turns/{id}/steer`; non-empty. */
export interface SteerRequest {
  message: string;
}

/** The body of `POST /v1/turns/{id}/pause`; every field optional. */
export interface PauseRequest {
  reason?: string | null;
}

/** Every non-2xx response body the server writes. */
export interface ErrorBody {
  error: string;
}

/** `GET /healthz`. */
export interface HealthView {
  status: string;
}

/**
 * `GET /readyz`: 200 with `ready`, or 503 with `starting` or `draining`. The
 * client reports both through one shape so a readiness gate reads one field.
 */
export interface ReadinessView {
  state: "ready" | "starting" | "draining" | (string & {});
  ready: boolean;
}
