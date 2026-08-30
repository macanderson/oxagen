/**
 * The ONE entrypoint for running a platform agent turn (agent-engine v2
 * Phase 1 — docs/specs/agent-engine-v2/plan.md, ADR-033).
 *
 * Every platform surface — app chat, REST chat, the A2A bridge, and the
 * `agent.repo.edit` fleet capability — enters the engine through this module
 * instead of importing `runCodingAgent`/`runTurn` directly. Behavior is a
 * byte-identical delegation; the value is the seam.
 *
 * Scope, precisely: these two functions run a turn IN-REQUEST. Durable runs
 * took a different route — run rows, the append-only event log, checkpoints,
 * fenced attempts, and resume all live in run-store.ts, driven by
 * `packages/agent-worker`, and they never call through here. So the seam's
 * remaining job is engine selection: swapping the engine behind a flag happens
 * HERE, without touching any surface.
 *
 * Two functions rather than one polymorphic spec, deliberately: the bare loop
 * and the judged pipeline take different option types and return different
 * results, and the call sites read best with the options object inline.
 */
import {
  runCodingAgent,
  runTurn,
  type RunCodingAgentOptions,
  type RunCodingAgentResult,
  type RunTurnOptions,
  type RunTurnResult,
} from "@oxagen/agent-engine";

/**
 * Which platform surface is running this turn. Inert on the in-request path —
 * nothing here routes on it. It exists so every caller declares its identity at
 * the seam, and it is the same union `agent_runs.surface` stores on the durable
 * path (`EnqueueRunInput.surface` in run-store.ts), so the two spellings of
 * "which surface" cannot drift apart.
 */
export type PlatformSurface = "chat" | "api-chat" | "a2a" | "repo-edit";

/**
 * Run one bare engine turn (the step loop, no judge/revise pipeline) for
 * `surface`. Exactly `runCodingAgent(engine)` today — see the module doc for
 * why the indirection exists.
 */
export function executeTurn(
  surface: PlatformSurface,
  engine: RunCodingAgentOptions,
): Promise<RunCodingAgentResult> {
  void surface; // declared at the seam; the in-request path records nothing
  return runCodingAgent(engine);
}

/**
 * Run one judged pipeline turn (evaluate → enhance → route → execute → judge
 * → revise) for `surface`. Exactly `runTurn(pipeline)` today.
 */
export function executePipelineTurn(
  surface: PlatformSurface,
  pipeline: RunTurnOptions,
): Promise<RunTurnResult> {
  void surface; // declared at the seam; the in-request path records nothing
  return runTurn(pipeline);
}
