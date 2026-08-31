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
 * remaining job is engine selection: Phase C swaps the engine behind the
 * `OXAGEN_ENGINE` flag HERE, without touching any surface — see
 * {@link executeTurn}.
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
import { resolveEngineChoice, type EngineChoice } from "./stella/engine-choice";

/**
 * Which platform surface is running this turn. Inert on the in-request path —
 * nothing here routes on it. It exists so every caller declares its identity at
 * the seam, and it is the same union `agent_runs.surface` stores on the durable
 * path (`EnqueueRunInput.surface` in run-store.ts), so the two spellings of
 * "which surface" cannot drift apart.
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
 * Run one bare engine turn (the step loop, no judge/revise pipeline) for
 * `surface`, on whichever engine the flag resolves to.
 *
 * Both engines satisfy the same contract — same options in, same result out,
 * same `onEvent`/`onStreamPart` streams — so no caller of this function can
 * tell which one ran, and none needed changing to gain the choice. That was the
 * whole point of building the seam in Phase 1.
 *
 * The Stella path is loaded lazily, only when it is actually chosen: a
 * deployment on the TS engine must not pay a module-load cost, and more
 * importantly must not construct a sidecar pool it will never use.
 */
export async function executeTurn(
  surface: PlatformSurface,
  engine: RunCodingAgentOptions,
  options: ExecuteTurnOptions = {},
): Promise<RunCodingAgentResult> {
  void surface; // declared at the seam; the in-request path records nothing
  const choice: EngineChoice = resolveEngineChoice({
    requested: options.requestedEngine,
    env: options.env,
  });
  if (choice === "stella") {
    const { runTurnOnStella } = await import("./stella/index");
    return runTurnOnStella(engine);
  }
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
