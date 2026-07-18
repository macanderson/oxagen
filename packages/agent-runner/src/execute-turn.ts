/**
 * The ONE entrypoint for running a platform agent turn (agent-engine v2
 * Phase 1 — docs/specs/agent-engine-v2/plan.md, ADR-033).
 *
 * Every platform surface — app chat, REST chat, the A2A bridge, and the
 * `agent.repo.edit` fleet capability — enters the engine through this module
 * instead of importing `runCodingAgent`/`runTurn` directly. Behavior today is
 * a byte-identical delegation; the value is the seam:
 *
 * - Phase 2 (durable runs) adds run rows, the append-only event log,
 *   per-step checkpoints, and resume HERE, without touching any surface.
 * - Phase 3 (embedded Stella core) swaps the engine behind an ENGINE flag
 *   HERE, without touching any surface.
 *
 * Two functions rather than one polymorphic spec, deliberately: the bare loop
 * and the judged pipeline take different option types and return different
 * results, and the call sites read best with the options object inline. The
 * consolidation into a serializable RunSpec happens in Phase 2, when run rows
 * force the options apart from the ports anyway.
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
 * Which platform surface is running this turn. Inert today (nothing routes on
 * it); it exists so every caller declares its identity at the seam, and so
 * Phase 2 can stamp it onto the run row / event log without another
 * all-call-sites sweep.
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
  void surface; // recorded on the run row starting in Phase 2
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
  void surface; // recorded on the run row starting in Phase 2
  return runTurn(pipeline);
}
