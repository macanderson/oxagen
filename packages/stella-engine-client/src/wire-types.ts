/**
 * Wire contract for oxagen's Stella sidecar transport (oxagen #1072) talking
 * to a headless `stella-serve` process.
 *
 * These are hand-authored TS mirrors of the Rust types in stella's
 * `stella-serve/src/frame.rs` (the `ServerFrame` / `ToolResultIn` /
 * `ProviderResultIn` vocabulary), `stella-serve/src/server.rs` (the
 * `TurnRequest` body), and `stella-protocol/src/{completion,tool,event}.rs`
 * (the payloads those carry). They are NOT generated from stella's source
 * (that codegen step is upstream work item #4 in stella's
 * docs/design/serve-surface.md) — until it lands, this file *is* the contract,
 * and stella-serve.smoke.test.ts is what proves it still matches a real
 * `stella-serve` at the pinned version.
 *
 * VERIFIED, not assumed: every route, field name and tag in this file was
 * checked against a locally built `stella-serve` 0.6.2 driving a real
 * multi-step turn (oxagen #1132). The previous revision of this file was a
 * good-faith mirror of a *planned* session-oriented surface that the server
 * never served — see #1132 for the drift table. If you are changing anything
 * here, re-run the smoke test against a real binary rather than reasoning
 * about it.
 *
 * If you are here because the smoke test just turned red: stella renamed or
 * restructured something. Update the type AND the assertions in the smoke
 * test together, then bump `stellaVersion` in sidecar.config.json in the same
 * commit.
 *
 * ## Shape of the protocol
 *
 * A *turn* is the top-level resource — there is no session resource. The host
 * POSTs a fully-assembled turn, then streams frames. Two of those frames are
 * **reverse RPC requests**: the engine holds no ambient authority, so it asks
 * the host to run every model call and every tool call, and parks the step
 * until the host POSTs the result back keyed by `request_id`. That is what
 * makes the host — not the engine — the owner of metering, gateway routing,
 * BYOK credentials and tool sandboxing.
 */

// ---------------------------------------------------------------------------
// Host -> engine: the turn request (`POST /v1/turns`)
// ---------------------------------------------------------------------------

/**
 * Spend policy for a turn — mirrors `BudgetSpec` in stella-serve/src/server.rs.
 *
 * The mode vocabulary is stella's `BudgetMode`: `observed` records spend
 * without refusing, `enforced` aborts the turn at the limit. There is no
 * `warn`/`hard` spelling.
 */
export interface BudgetSpec {
  readonly mode: "off" | "observed" | "enforced";
  readonly turn_limit_usd?: number | null;
  readonly session_limit_usd?: number | null;
}

/**
 * Body of `POST /v1/turns`. The host owns prompt assembly, model selection and
 * the tool set; engine knobs are optional overrides on top of the defaults.
 */
export interface TurnRequest {
  /** Echoed on the engine's `Provider::id()` — labelling only. */
  readonly provider_id: string;
  /** Tool schemas the model may call. Execution is remoted back to the host. */
  readonly tools?: readonly ToolSchema[];
  /** The already-assembled conversation to run this turn. */
  readonly messages: readonly CompletionMessage[];
  readonly budget?: BudgetSpec;
  /** Clamped server-side to 10_000; `0` is rejected as unusable. */
  readonly max_steps?: number;
  /**
   * Per-reverse-request deadline. Omitted means five minutes; clamped
   * server-side to one hour, and `0` is rejected.
   */
  readonly reverse_request_timeout_ms?: number;
}

/** Response to `POST /v1/turns`. */
export interface TurnCreated {
  readonly turn_id: string;
}

// ---------------------------------------------------------------------------
// Engine -> host: the frame stream (`GET /v1/turns/{id}/events`, SSE)
// ---------------------------------------------------------------------------

/**
 * One `AgentEvent`, stella's ~30-variant UI event enum
 * (`stella-protocol/src/event.rs`), internally tagged on `type` with
 * snake_case variant names.
 *
 * Deliberately left open: the enum is additive-only upstream, so pinning every
 * variant here would turn every stella release into an oxagen typecheck
 * failure for no benefit. The variants oxagen actually branches on are typed
 * below; everything else flows through as an envelope.
 *
 * NOTE: there is no `seq` field. The previous revision of this file declared
 * one and called it "the resumable-subscription invariant"; the server emits
 * no sequence number and retains no event history, so a dropped connection
 * loses whatever streamed while it was down. Resumption via `?after=<seq>` is
 * named as unbuilt in stella's docs/design/serve-surface.md.
 */
export interface AgentEventEnvelope {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Emitted when the engine begins dispatching a tool call. */
export interface ToolStartEvent extends AgentEventEnvelope {
  readonly type: "tool_start";
}

/** Emitted when a tool call's result is committed back into the transcript. */
export interface ToolResultEvent extends AgentEventEnvelope {
  readonly type: "tool_result";
}

/** Assistant text produced this step. */
export interface TextEvent extends AgentEventEnvelope {
  readonly type: "text";
}

/**
 * The engine's own terminal `AgentEvent` as stella 0.6.2 — the pinned version
 * in `sidecar.config.json` — emits it. Distinct from `TurnCompleteFrame`.
 *
 * Stella renamed this tag to `turn_complete` after 0.6.2; see
 * {@link TurnCompleteEvent}. Both are modelled because the two CI workflows
 * see different stella builds, and neither tag is wrong.
 */
export interface CompleteEvent extends AgentEventEnvelope {
  readonly type: "complete";
}

/**
 * The same terminal `AgentEvent` as stella `main` emits it.
 *
 * `stella-sidecar.yml` boots the pinned 0.6.2 build, which sends `complete`;
 * `stella-sidecar-nightly.yml` builds stella `main`, which sends
 * `turn_complete` (and `run_complete` beside it). Its `AgentEvent` vocabulary
 * is generated from one table — `crates/stella-protocol/src/event/tags.rs` —
 * and that table has `TurnComplete => "turn_complete"` with no bare `complete`
 * arm left.
 *
 * It shares a tag string with `TurnCompleteFrame` and is still a different
 * type: one is an event carried on the stream, the other the frame that ends
 * it. Stella does the same, for the same reason.
 *
 * Both this and {@link CompleteEvent} stay until `stellaVersion` moves past
 * the rename — bumping that pin is its own deliberate commit, per
 * `sidecar.config.json`. Prefer {@link isTerminalTurnEvent} over either guard.
 */
export interface TurnCompleteEvent extends AgentEventEnvelope {
  readonly type: "turn_complete";
}

/**
 * A frame on the turn's event stream. Internally tagged on `type`, snake_case
 * — mirrors `ServerFrame` in stella-serve/src/frame.rs.
 *
 * This is the layer the previous revision was missing entirely: it modelled
 * the stream as bare `AgentEvent`s, so the two reverse-RPC request frames had
 * nowhere to land and a turn could never be driven to completion.
 *
 * Three ordering properties a correct host must not assume away:
 *
 * 1. `event` frames are NOT ordered against `tool_request`/`provider_request`.
 *    Events travel through a forwarder task while reverse-RPC frames are
 *    written straight to the channel by the ports, so a `tool_request` can
 *    overtake the `tool_start` event that logically precedes it.
 * 2. Several `tool_request`s can be outstanding at once — the engine runs
 *    consecutive `read_only: true` calls concurrently. Answer by `request_id`
 *    in any order; a host that assumes one-at-a-time will stall the group.
 * 3. Exactly one `turn_complete`, always last. Every `event` frame precedes it.
 */
export type ServerFrame =
  | EventFrame
  | ToolRequestFrame
  | ProviderRequestFrame
  | TurnCompleteFrame;

/** A normal agent event — stream it to the UI. Never requires a response. */
export interface EventFrame {
  readonly type: "event";
  readonly event: AgentEventEnvelope;
}

/**
 * The engine needs the host to run a tool call and POST a {@link ToolResultIn}
 * back keyed by `request_id`. The engine step that raised it is parked until
 * then, up to the turn's reverse-request deadline.
 */
export interface ToolRequestFrame {
  readonly type: "tool_request";
  readonly request_id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * The engine needs the host to run a model completion and POST a
 * {@link ProviderResultIn} back keyed by `request_id`. The host owns the model
 * call — metering, gateway, BYOK — and the engine only orchestrates.
 */
export interface ProviderRequestFrame {
  readonly type: "provider_request";
  readonly request_id: string;
  readonly request: CompletionRequest;
}

/** Terminal frame: the turn ended. No further frames follow. */
export interface TurnCompleteFrame {
  readonly type: "turn_complete";
  readonly outcome: TurnOutcome;
}

/** Tagged on `status` — mirrors `TurnOutcomeWire`. */
export type TurnOutcome =
  | {
      readonly status: "completed";
      readonly text: string;
      readonly cost_usd: number;
    }
  | {
      readonly status: "aborted";
      readonly reason: string;
      readonly cost_usd: number;
    };

// ---------------------------------------------------------------------------
// Host -> engine: reverse-RPC results
// ---------------------------------------------------------------------------

/**
 * Body of `POST /v1/turns/{id}/tool-result` — mirrors `ToolResultIn`.
 *
 * There is no `is_error` boolean anywhere in this protocol: tool failure is
 * the `error` arm of {@link ToolOutput}, which the engine surfaces to the
 * model as text it can react to.
 */
export interface ToolResultIn {
  readonly request_id: string;
  readonly output: ToolOutput;
}

/**
 * Body of `POST /v1/turns/{id}/provider-result` — mirrors `ProviderResultIn`,
 * whose outcome is `#[serde(flatten)]`ed, so `status` sits at the top level
 * alongside `request_id` rather than nested.
 */
export type ProviderResultIn = { readonly request_id: string } & (
  | { readonly status: "ok"; readonly result: CompletionResult }
  | { readonly status: "error"; readonly error: ProviderError }
);

/**
 * Mirror of stella's `ProviderError` taxonomy, tagged on `kind`. The host
 * classifies the failure at its own adapter and sends the class; the engine
 * reconstructs a real `ProviderError` so its retry logic behaves exactly as it
 * would with a local provider.
 *
 * The classification is load-bearing, not cosmetic: `transport` and
 * `rate_limited` are retried with backoff, while `auth`, `unknown_model`,
 * `malformed`, `cancelled` and `terminal` fail the turn immediately.
 */
export type ProviderError =
  | { readonly kind: "transport"; readonly message: string }
  | {
      readonly kind: "rate_limited";
      readonly message: string;
      readonly retry_after_ms?: number | null;
    }
  | { readonly kind: "auth"; readonly message: string }
  | { readonly kind: "unknown_model"; readonly slug: string }
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "terminal"; readonly message: string };

// ---------------------------------------------------------------------------
// Shared payloads (stella-protocol)
// ---------------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Externally tagged, unlike every other enum here: `ToolOutput` carries no
 * `#[serde(tag = ...)]`, so it serializes as `{"ok": {...}}` / `{"error": {...}}`.
 */
export type ToolOutput =
  | { readonly ok: { readonly content: string } }
  | { readonly error: { readonly message: string } };

export interface ToolCall {
  readonly call_id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ToolResult {
  readonly call_id: string;
  readonly output: ToolOutput;
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the object the model must send as `ToolCall.input`. */
  readonly input_schema: Record<string, unknown>;
  /** Defaults to false — unknown tools are treated as mutating. */
  readonly read_only?: boolean;
}

/**
 * One message in the conversation. Every optional field is
 * `skip_serializing_if` empty upstream, so it is genuinely absent — not null —
 * when unused. That omission is part of the prompt-cache stability contract:
 * a text-only message must serialize byte-for-byte as it always has.
 */
export interface CompletionMessage {
  readonly role: MessageRole;
  /** Absent on an assistant message that only made tool calls. */
  readonly content?: string;
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_results?: readonly ToolResult[];
  readonly attachments?: readonly Record<string, unknown>[];
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** What the engine asks the host to complete, inside a `provider_request`. */
export interface CompletionRequest {
  readonly messages: readonly CompletionMessage[];
  readonly max_output_tokens?: number;
  readonly temperature?: number;
  readonly effort?: ReasoningEffort;
  readonly reasoning?: boolean;
  readonly params?: Record<string, unknown>;
  readonly tools?: readonly ToolSchema[];
}

export interface CompletionUsage {
  /** Whether the provider actually reported usage, vs. it being estimated. */
  readonly reported?: boolean;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens?: number;
  readonly cache_write_tokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

/**
 * What the host returns for a `provider_request`.
 *
 * `usage`, `model` and `cost_usd` are REQUIRED — the engine folds `cost_usd`
 * into the turn's settled cost, which is why a host that omits it silently
 * under-reports spend. `finish_reason` is `tool_calls`, never `tool_use`
 * (that spelling is Anthropic's, not stella's, and the server rejects it with
 * a 400 naming the valid variants).
 */
export interface CompletionResult {
  readonly text?: string;
  readonly tool_calls?: readonly ToolCall[];
  readonly usage: CompletionUsage;
  readonly model: string;
  readonly cost_usd: number;
  readonly finish_reason?: FinishReason | null;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function isEventFrame(frame: ServerFrame): frame is EventFrame {
  return frame.type === "event";
}

export function isToolRequestFrame(
  frame: ServerFrame,
): frame is ToolRequestFrame {
  return frame.type === "tool_request";
}

export function isProviderRequestFrame(
  frame: ServerFrame,
): frame is ProviderRequestFrame {
  return frame.type === "provider_request";
}

export function isTurnCompleteFrame(
  frame: ServerFrame,
): frame is TurnCompleteFrame {
  return frame.type === "turn_complete";
}

export function isToolStartEvent(
  event: AgentEventEnvelope,
): event is ToolStartEvent {
  return event.type === "tool_start";
}

export function isToolResultEvent(
  event: AgentEventEnvelope,
): event is ToolResultEvent {
  return event.type === "tool_result";
}

export function isTextEvent(event: AgentEventEnvelope): event is TextEvent {
  return event.type === "text";
}

export function isCompleteEvent(
  event: AgentEventEnvelope,
): event is CompleteEvent {
  return event.type === "complete";
}

export function isTurnCompleteEvent(
  event: AgentEventEnvelope,
): event is TurnCompleteEvent {
  return event.type === "turn_complete";
}

/**
 * The terminal `AgentEvent` under whichever tag this stella build uses.
 *
 * Call this rather than either guard alone: which one matches depends on the
 * `stellaVersion` pin, and a consumer that waits on only one silently never
 * terminates against the other build.
 */
export function isTerminalTurnEvent(
  event: AgentEventEnvelope,
): event is CompleteEvent | TurnCompleteEvent {
  return isCompleteEvent(event) || isTurnCompleteEvent(event);
}
