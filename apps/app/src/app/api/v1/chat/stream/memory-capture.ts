// memory-capture.ts — wires the server chat turn into Engram (agent memory)
// so the "memory capture is always active" claim is actually true for the
// in-app chat surface, not just a documented intent.
//
// WHY this exists: emitAgentEvent/emitToolCall
// (@oxagen/agent/runtime/engram-writer) write episodic events to the Engram
// store and fire the async graph-sync/embed events, but until this module
// NOTHING in the codebase called them — not this route, not the CLI, no
// surface. The nightly consolidation job (engram.consolidation.impl.ts)
// distills, reinforces, and decays FROM these episodic events, so without
// this wiring the consolidation pipeline had nothing from the chat surface
// to work with, no matter how correctly it ran.
//
// Non-blocking by design: every emit here is fire-and-forget (`void`, never
// awaited) — emitAgentEvent already swallows its own errors internally
// (agent memory writes must never add latency to, or fail, a chat turn).
//
// Tenancy: every event carries the SAME org/workspace ids the caller already
// resolved and membership-asserted for this request — never derived from
// ambient/global state — so one request can only ever emit into its OWN
// tenant's namespace. bootstrapEngramRuntime() (apps/app/instrumentation.ts)
// registers the async graph-sync/embed backends at server startup, so these
// calls are live the moment this module is imported.
import type { CodingEvent } from "@oxagen/agent-engine";
import {
  emitAgentEvent,
  emitToolCall,
  type AgentEventContext,
} from "@oxagen/agent/runtime/engram-writer";

export type { AgentEventContext } from "@oxagen/agent/runtime/engram-writer";

/**
 * Build the engine's `onEvent` handler that captures every completed tool
 * call as an episodic event. Only reacts to `tool-result` — a `tool-call`
 * part carries no outcome/duration yet, and the engine always emits a
 * matching `tool-result` once the call settles (success or error), so
 * nothing is missed by waiting for it.
 */
export function createChatEngramOnEvent(
  ctx: AgentEventContext,
): (event: CodingEvent) => void {
  return (event: CodingEvent) => {
    if (event.type !== "tool-result") return;
    void emitToolCall(ctx, event.name, event.ok ? "success" : "failure", {
      input: event.input,
      result: event.result,
      durationMs: event.durationMs,
    });
  };
}

export interface ChatTurnMemoryArgs {
  instruction: string;
  responseLength: number;
  changedFiles: string[];
  steps: number;
  outcome: "success" | "failure";
}

/**
 * Emit ONE turn-level episodic event summarizing the whole chat turn, in
 * addition to the per-tool-call events createChatEngramOnEvent's handler
 * captures — so a tool-free Q&A turn still populates agent memory, not only
 * turns that happen to call a tool.
 */
export function emitChatTurnMemory(
  ctx: AgentEventContext,
  args: ChatTurnMemoryArgs,
): void {
  void emitAgentEvent(ctx, {
    event: "chat_turn",
    payload: {
      instruction: args.instruction,
      responseLength: args.responseLength,
      changedFiles: args.changedFiles,
      steps: args.steps,
    },
    outcome: args.outcome,
  });
}
