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
 * per-run request wins, otherwise the process default. Both now resolve to the
 * same engine — Stella is the only one left — so the module's job has narrowed
 * to refusing everything else by name.
 *
 * There is no third input, and specifically no "is a sidecar reachable" probe:
 * a request for Stella that cannot be honoured must fail loudly. There is no
 * longer a second engine to fall back TO, which is what makes the refusal
 * total rather than a policy.
 */
import { RUN_ENGINES } from "../run-spec-v2";

/** `"stella"` — the Rust engine sidecar, and now the only engine. */
export type EngineChoice = (typeof RUN_ENGINES)[number];

/** The engine used when nothing asks for another, and the only one there is. */
export const DEFAULT_ENGINE: EngineChoice = "stella";

/**
 * Engines that existed and no longer do. Kept as a vocabulary so a request for
 * one produces a sentence saying what happened rather than "unknown engine" —
 * an operator whose `OXAGEN_ENGINE=ts` stops working is owed the reason, not a
 * list of valid values they have to interpret.
 */
export const RETIRED_ENGINES: Readonly<Record<string, string>> = {
  ts: "the in-process TypeScript step loop, deleted once Stella became the only engine",
};

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

/**
 * Raised when the engine flag names an engine this codebase used to have.
 *
 * Separate from {@link UnknownEngineError} because the remedies differ: a typo
 * is fixed by spelling the engine correctly, while this one is fixed by
 * accepting that the engine is gone. Both throw — neither ever falls back —
 * because a run that asked for a specific engine and silently got another is
 * the failure the whole engine-choice module exists to prevent.
 */
export class RetiredEngineError extends Error {
  constructor(
    readonly value: string,
    readonly source: string,
  ) {
    super(
      `${source} asks for the ${JSON.stringify(value)} engine, which was removed — ` +
        `${RETIRED_ENGINES[value]}. Stella is the only engine; drop the setting to use it.`,
    );
    this.name = "RetiredEngineError";
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
 * Throws on any value that is not an engine rather than falling back to the
 * default — {@link RetiredEngineError} for one this codebase used to have,
 * {@link UnknownEngineError} for one it never had. Falling back would run the
 * turn on an engine nobody asked for and report success, which is a green
 * signal answering a question nobody asked. The env schema
 * (`packages/config`'s `OXAGEN_ENGINE`) rejects the same values at boot, so in
 * a correctly-booted process these throws are unreachable; they are the
 * backstop for a worker that read `process.env` without going through the
 * schema.
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
    return admit(requested, "the run's requested_engine");
  }

  const configured = env[ENGINE_ENV_VAR];
  if (configured == null || configured === "") return DEFAULT_ENGINE;
  return admit(configured, `$${ENGINE_ENV_VAR}`);
}

/** Retired is checked before unknown, so a removed engine says so by name. */
function admit(value: string, source: string): EngineChoice {
  if (value in RETIRED_ENGINES) throw new RetiredEngineError(value, source);
  if (!isEngineChoice(value)) throw new UnknownEngineError(value, source);
  return value;
}
