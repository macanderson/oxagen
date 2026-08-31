/**
 * Which engine runs a turn (agent-engine v2 Phase C;
 * docs/specs/agent-engine-v2/plan.md § "Phase 3").
 *
 * The vocabulary is `RUN_ENGINES` — the same closed enum a RunSpec v2 admits
 * through `enginePolicySchema.requested_engine`, imported rather than
 * re-spelled so a third engine can never be admissible in one place and
 * unknown in the other.
 *
 * Resolution has exactly two inputs and one precedence rule: an explicit
 * per-run request wins, otherwise the process default. The per-run request is
 * what makes Phase D's shadow slice expressible — mirroring a fraction of real
 * runs through Stella is a property of the run, not of the deployment — while
 * the process default is what an operator flips to move a whole worker fleet.
 *
 * There is no third input, and specifically no "is a sidecar reachable" probe:
 * a request for Stella that cannot be honoured must fail loudly rather than
 * silently completing on the TS engine, because a shadow comparison whose
 * Stella arm quietly ran the control is worse than no comparison.
 */
import { RUN_ENGINES } from "../run-spec-v2";

/** `"ts"` (the TypeScript step loop) or `"stella"` (the Rust engine sidecar). */
export type EngineChoice = (typeof RUN_ENGINES)[number];

/**
 * The engine used when nothing asks for another. `"ts"` through Phase C and
 * Phase D: Phase C ships the capability, and the plan's Phase D parity gate is
 * what earns the default, not this constant.
 */
export const DEFAULT_ENGINE: EngineChoice = "ts";

/** The environment variable an operator flips to move a whole worker fleet. */
export const ENGINE_ENV_VAR = "OXAGEN_ENGINE";

/** Raised when the engine flag holds something that is not an engine. */
export class UnknownEngineError extends Error {
  constructor(
    readonly value: string,
    readonly source: string,
  ) {
    super(
      `${source} names an unknown engine ${JSON.stringify(value)} — ` +
        `expected one of: ${RUN_ENGINES.join(", ")}`,
    );
    this.name = "UnknownEngineError";
  }
}

export function isEngineChoice(value: unknown): value is EngineChoice {
  return (
    typeof value === "string" &&
    (RUN_ENGINES as readonly string[]).includes(value)
  );
}

/**
 * Resolve the engine for one turn.
 *
 * Throws {@link UnknownEngineError} on a value that is not an engine rather
 * than falling back to the default. A typo in the flag would otherwise run
 * every turn on the TS engine while the operator believed they had cut over —
 * a green signal answering a question nobody asked. The env schema
 * (`packages/config`'s `OXAGEN_ENGINE`) rejects the same value at boot, so in a
 * correctly-booted process this throw is unreachable; it is the backstop for a
 * worker that read `process.env` without going through the schema.
 */
export function resolveEngineChoice(
  options: {
    /** The run's own `enginePolicy.requested_engine`, when it has one. */
    requested?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): EngineChoice {
  const { requested, env = process.env } = options;

  if (requested != null && requested !== "") {
    if (!isEngineChoice(requested)) {
      throw new UnknownEngineError(requested, "the run's requested_engine");
    }
    return requested;
  }

  const configured = env[ENGINE_ENV_VAR];
  if (configured == null || configured === "") return DEFAULT_ENGINE;
  if (!isEngineChoice(configured)) {
    throw new UnknownEngineError(configured, `$${ENGINE_ENV_VAR}`);
  }
  return configured;
}
