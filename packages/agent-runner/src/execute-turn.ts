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
 * - Phase C (the Stella engine) swaps the engine behind the `OXAGEN_ENGINE`
 *   flag HERE, without touching any surface — see {@link executeTurn}.
 *
 * Two functions rather than one polymorphic spec, deliberately: the bare loop
 * and the judged pipeline take different option types and return different
 * results, and the call sites read best with the options object inline. The
 * consolidation into a serializable RunSpec happens in Phase 2, when run rows
 * force the options apart from the ports anyway.
 */
import {
  runTurn,
  type RunCodingAgentOptions,
  type RunCodingAgentResult,
  type RunTurnOptions,
  type RunTurnResult,
} from "@oxagen/agent-engine";
import { resolveEngineChoice, type EngineChoice } from "./stella/engine-choice";

/**
 * Which platform surface is running this turn. Inert today (nothing routes on
 * it); it exists so every caller declares its identity at the seam, and so
 * Phase 2 can stamp it onto the run row / event log without another
 * all-call-sites sweep.
 */
export type PlatformSurface = "chat" | "api-chat" | "a2a" | "repo-edit";

/** Per-turn overrides at the seam. Every field is optional and inert by default. */
export interface ExecuteTurnOptions {
  /**
   * The run's own `enginePolicy.requested_engine`, when it has one. Wins over
   * the process default, which is what makes Phase D's shadow slice a property
   * of the run rather than of the deployment.
   */
  requestedEngine?: string | null;
  /** Overrides the ambient environment. For tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run one bare engine turn (no judge/revise pipeline) for `surface`.
 *
 * `resolveEngineChoice` is still consulted even though it can only answer
 * `stella`: its job now is to REFUSE a run that asked for the deleted
 * TypeScript loop, rather than run it on Stella and report success for an
 * engine nobody selected.
 *
 * The Stella path stays a lazy import. It costs nothing to keep and it means a
 * process that never runs a turn — a CLI printing help, a test importing this
 * module for its types — still does not construct a sidecar pool.
 */
export async function executeTurn(
  surface: PlatformSurface,
  engine: RunCodingAgentOptions,
  options: ExecuteTurnOptions = {},
): Promise<RunCodingAgentResult> {
  void surface; // recorded on the run row starting in Phase 2
  const choice: EngineChoice = resolveEngineChoice({
    requested: options.requestedEngine,
    env: options.env,
  });
  void choice; // "stella" or it threw; kept so the refusal is not optimised away
  const { runTurnOnStella } = await import("./stella/index");
  return runTurnOnStella(engine);
}

/**
 * Run one judged pipeline turn (evaluate → enhance → route → execute → judge
 * → revise) for `surface`.
 *
 * The pipeline stays host-side — it wraps turns, it is not inside one — but
 * each execution segment goes through {@link executeTurn}, so a judged turn
 * reaches the engine exactly as a bare one does. Injected via
 * `RunTurnOptions.execute`, which is REQUIRED now that the pipeline has no
 * in-process loop to fall back on, and injected rather than imported because
 * the dependency points this way: the engine package cannot import this one.
 */
export function executePipelineTurn(
  surface: PlatformSurface,
  pipeline: Omit<RunTurnOptions, "execute">,
  options: ExecuteTurnOptions = {},
): Promise<RunTurnResult> {
  // `execute` is this function's whole contribution, so a caller cannot pass
  // one: supplying the engine here is what makes a judged turn reach the same
  // engine a bare one does. It is spread last so the type and the runtime
  // agree about which value wins.
  return runTurn({
    ...pipeline,
    execute: (segment) => executeTurn(surface, segment, options),
  });
}
