/**
 * The ONE entrypoint for running a platform agent turn.
 *
 * Every platform surface — the web app's chat route, the REST chat API, the
 * A2A bridge, and the `agent.repo.edit` fleet capability — enters the engine
 * through this module. That seam is what made the engine swap a one-file
 * change: the surfaces call `executeTurn`, and `executeTurn` decides what runs
 * a turn.
 *
 * ## What runs a turn
 *
 * Stella, over its headless serve surface. `stella-serve` owns the agent loop —
 * steps, compaction, loop detection, budget boundaries, read-only-partitioned
 * tool dispatch — and holds NO ambient authority: it never calls a model and
 * never executes a tool. It asks, and `stella-runner` answers, so every model
 * call still goes through `@oxagen/ai` and every tool call still re-enters the
 * capability kernel's IAM, entitlement and billing gates.
 *
 * There is deliberately no engine flag. Two engines behind a switch means two
 * code paths, two sets of behaviour to reason about, and a losing branch that
 * rots — so the swap is the whole swap.
 */
import type {
  RunCodingAgentOptions,
  RunCodingAgentResult,
  RunTurnOptions,
  RunTurnResult,
} from "@oxagen/agent-engine";
import { runTurn } from "@oxagen/agent-engine";
import { runCodingAgentOnStella, type StellaRunDeps } from "./stella-runner";

/**
 * Which platform surface is running this turn. Carried so a run row and the
 * event log can record who asked, without another all-call-sites sweep.
 */
export type PlatformSurface = "chat" | "api-chat" | "a2a" | "repo-edit";

/**
 * Run one agent turn for `surface`.
 *
 * `deps` exists for tests, which inject a client pointed at a fake sidecar
 * rather than reaching for the ambient environment.
 */
export function executeTurn(
  surface: PlatformSurface,
  engine: RunCodingAgentOptions,
  deps: StellaRunDeps = {},
): Promise<RunCodingAgentResult> {
  void surface;
  return runCodingAgentOnStella(engine, deps);
}

/**
 * Run one judged multi-round turn for `surface`.
 *
 * Still the TypeScript pipeline. Stella serves judged multi-round runs natively
 * — a `goal` block with its own verifier role — and that is where this belongs,
 * because a judge/revise loop in one language wrapped around an engine in
 * another is two brains disagreeing about one turn. Moving it requires the
 * round-by-round trace this returns (`TurnTrace`) to be reconstructed from
 * engine events first, which is a separate change from the engine swap.
 */
export function executePipelineTurn(
  surface: PlatformSurface,
  pipeline: RunTurnOptions,
): Promise<RunTurnResult> {
  void surface;
  return runTurn(pipeline);
}
