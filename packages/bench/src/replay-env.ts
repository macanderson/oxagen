// Reconstructs the shell environment for the agent-arena harness's
// `bench/<bench-type>/run.sh` from a stored BenchReplayConfig JSON blob
// (bench.benchmark_run(_result).config). Pure mapping — no
// process/env/child_process access here; the caller (the internal bench
// replay command, commands.ts) decides whether to print or execute it.
//
// That harness is a separate checkout (https://github.com/macanderson/agent-arena),
// so the paths built here are relative to ITS root, not this repo's.

import type { BenchReplayConfig, BenchType } from "./types";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean {
  return v === true;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

// "AI_GATEWAY_API_KEY", "N_CONCURRENT", "OXAGEN_EFFORT" — an env var NAME.
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A scalar env-assignable value coerced to its shell string form, or undefined if it isn't one. */
function coerceEnvValue(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "1" : undefined;
  return undefined;
}

/**
 * Map a stored replay config back to the env vars the harness's run.sh (and
 * the container it launches) read.
 *
 * Two input shapes, both supported:
 *
 * 1. **Raw env-var-named keys** — how `bench-config.json` is actually
 *    written: the runner forwards every host `OXAGEN_*` var verbatim into the
 *    trial container rather than mapping it through a friendlier schema, so
 *    the snapshot captures exactly that: raw names like
 *    `OXAGEN_BEST_OF_N_MODELS`, `DATASET`, `N_CONCURRENT`, `TASK_IDS`. These
 *    pass straight through unchanged — no translation needed, since they're
 *    already valid shell assignments.
 * 2. **Conventional lower-camelCase keys** (`models`, `candidates`,
 *    `effort`, ... — see `BenchReplayConfig`'s doc comment) for a config
 *    assembled by hand rather than captured from a live shell. Only fills
 *    gaps the raw pass above didn't already set — an explicit raw key always
 *    wins, since it's unambiguous.
 *
 * An unrecognised key (in either shape) is silently ignored rather than
 * guessed at, since forwarding an arbitrary key as an env var could change
 * run.sh's behavior in an unintended way.
 */
export function buildReplayEnv(
  config: BenchReplayConfig,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    if (!ENV_VAR_NAME_PATTERN.test(key)) continue;
    const coerced = coerceEnvValue(value);
    if (coerced !== undefined) env[key] = coerced;
  }

  const models = strArray(config.models);
  const candidates = num(config.candidates);
  if ((models || candidates !== undefined) && !("OXAGEN_BEST_OF_N" in env))
    env.OXAGEN_BEST_OF_N = "1";
  if (models && !("OXAGEN_BEST_OF_N_MODELS" in env))
    env.OXAGEN_BEST_OF_N_MODELS = models.join(",");
  if (candidates !== undefined && !("OXAGEN_BEST_OF_N_CANDIDATES" in env)) {
    env.OXAGEN_BEST_OF_N_CANDIDATES = String(candidates);
  }
  if (bool(config.pipeline) && !("OXAGEN_BEST_OF_N_PIPELINE" in env))
    env.OXAGEN_BEST_OF_N_PIPELINE = "1";
  if (bool(config.verifyAuto) && !("OXAGEN_BEST_OF_N_VERIFY" in env))
    env.OXAGEN_BEST_OF_N_VERIFY = "1";
  if (bool(config.warm) && !("OXAGEN_WARM" in env)) env.OXAGEN_WARM = "1";

  const effort = str(config.effort);
  if (effort && !("OXAGEN_EFFORT" in env)) env.OXAGEN_EFFORT = effort;
  const evaluator = str(config.evaluator);
  if (evaluator && !("OXAGEN_LLM_EVALUATOR" in env))
    env.OXAGEN_LLM_EVALUATOR = evaluator;
  const advisor = str(config.advisor);
  if (advisor && !("OXAGEN_LLM_ADVISOR" in env))
    env.OXAGEN_LLM_ADVISOR = advisor;
  const reviseRounds = num(config.reviseRounds);
  if (reviseRounds !== undefined && !("OXAGEN_MAX_REVISE_ROUNDS" in env)) {
    env.OXAGEN_MAX_REVISE_ROUNDS = String(reviseRounds);
  }

  const nConcurrent = num(config.nConcurrent);
  if (nConcurrent !== undefined && !("N_CONCURRENT" in env))
    env.N_CONCURRENT = String(nConcurrent);
  const dataset = str(config.dataset);
  if (dataset && !("DATASET" in env)) env.DATASET = dataset;

  const taskIds =
    strArray(config.taskIds) ??
    (str(config.taskId) ? [config.taskId as string] : undefined);
  if (taskIds && !("TASK_IDS" in env)) env.TASK_IDS = taskIds.join(" ");

  const model = str(config.model);
  if (model && !("OXAGEN_MODEL_SLUG" in env)) env.OXAGEN_MODEL_SLUG = model;

  return env;
}

/** Path to the run.sh script for a bench type, relative to the agent-arena checkout's root. */
export function runScriptFor(benchType: BenchType): string {
  return `bench/${benchType}/run.sh`;
}

/** Render env vars as a single-line shell prefix, e.g. `FOO="1" BAR="a b"`. */
export function formatEnvPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
}

function shellQuote(value: string): string {
  // Safe for the values this module produces (comma/space-joined lists,
  // model slugs, numbers) — always double-quote so a space-containing
  // TASK_IDS list survives word-splitting.
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
