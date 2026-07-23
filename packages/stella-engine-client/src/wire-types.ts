/**
 * Wire contract for oxagen's Stella sidecar transport (oxagen #1072) talking
 * to a headless `stella serve` process (stella#258).
 *
 * These are hand-authored TS mirrors of stella's `AgentEvent` enum
 * (`stella-protocol/src/event.rs`, see docs/specs/agent-engine-v2/spec.md
 * §2.6) as serialized over the sidecar's event stream. They are NOT
 * generated from stella's source in this repo (that codegen step is upstream
 * work item #3 in docs/specs/agent-engine-v2/spec.md §6) — until it lands,
 * this file *is* the contract, and stella-serve.smoke.test.ts is what proves
 * it still matches a real `stella serve` on the pinned version.
 *
 * If you are here because the smoke test just turned red: stella renamed or
 * restructured a field on one of these events. Update the type AND the
 * assertions in the smoke test together, then bump `stellaVersion` in
 * sidecar.config.json in the same commit.
 */

/** A session opened against a running `stella serve` process. */
export interface StellaSession {
  readonly sessionId: string;
}

/** Every event on the session's event stream carries a monotonic seq. */
export interface StellaEventEnvelope {
  readonly seq: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Emitted when the engine dispatches a tool call to the host. */
export interface ToolCallEvent extends StellaEventEnvelope {
  readonly type: "tool_call";
  readonly call_id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** Emitted when a tool call's result is committed back into the transcript. */
export interface ToolResultEvent extends StellaEventEnvelope {
  readonly type: "tool_result";
  readonly call_id: string;
  readonly output: unknown;
  readonly is_error: boolean;
}

/** The single terminal event for a turn — exactly one per turn, always last. */
export interface CompleteEvent extends StellaEventEnvelope {
  readonly type: "complete";
  readonly stop_reason: string;
}

export type StellaEvent =
  | ToolCallEvent
  | ToolResultEvent
  | CompleteEvent
  | StellaEventEnvelope;

export function isToolCallEvent(
  event: StellaEventEnvelope,
): event is ToolCallEvent {
  return event.type === "tool_call";
}

export function isToolResultEvent(
  event: StellaEventEnvelope,
): event is ToolResultEvent {
  return event.type === "tool_result";
}

export function isCompleteEvent(
  event: StellaEventEnvelope,
): event is CompleteEvent {
  return event.type === "complete";
}
