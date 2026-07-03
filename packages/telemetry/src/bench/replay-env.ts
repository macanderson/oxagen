// Reconstructs the shell environment for `bench/{swe-bench,terminal-bench}/run.sh`
// from a stored BenchReplayConfig JSON blob (bench.benchmark_run(_result).config).
// Pure mapping — no process/env/child_process access here; the caller (the
// `oxagen bench replay` CLI command) decides whether to print or execute it.

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
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/**
 * Map a stored replay config back to the env vars `bench/*\/run.sh` reads
 * (see that script's usage header). Conventional keys only (see
 * `BenchReplayConfig`'s doc comment) — an unrecognised key is silently
 * ignored rather than guessed at, since forwarding an arbitrary key as an
 * env var could change run.sh's behavior in an unintended way.
 */
export function buildReplayEnv(config: BenchReplayConfig): Record<string, string> {
  const env: Record<string, string> = {};

  const models = strArray(config.models);
  const candidates = num(config.candidates);
  if (models || candidates !== undefined) env.OXAGEN_BEST_OF_N = "1";
  if (models) env.OXAGEN_BEST_OF_N_MODELS = models.join(",");
  if (candidates !== undefined) env.OXAGEN_BEST_OF_N_CANDIDATES = String(candidates);
  if (bool(config.pipeline)) env.OXAGEN_BEST_OF_N_PIPELINE = "1";
  if (bool(config.verifyAuto)) env.OXAGEN_BEST_OF_N_VERIFY = "1";
  if (bool(config.warm)) env.OXAGEN_WARM = "1";

  const effort = str(config.effort);
  if (effort) env.OXAGEN_EFFORT = effort;
  const evaluator = str(config.evaluator);
  if (evaluator) env.OXAGEN_LLM_EVALUATOR = evaluator;
  const advisor = str(config.advisor);
  if (advisor) env.OXAGEN_LLM_ADVISOR = advisor;
  const reviseRounds = num(config.reviseRounds);
  if (reviseRounds !== undefined) env.OXAGEN_MAX_REVISE_ROUNDS = String(reviseRounds);

  const nConcurrent = num(config.nConcurrent);
  if (nConcurrent !== undefined) env.N_CONCURRENT = String(nConcurrent);
  const dataset = str(config.dataset);
  if (dataset) env.DATASET = dataset;

  const taskIds = strArray(config.taskIds) ?? (str(config.taskId) ? [config.taskId as string] : undefined);
  if (taskIds) env.TASK_IDS = taskIds.join(" ");

  const model = str(config.model);
  if (model) env.OXAGEN_MODEL_SLUG = model;

  return env;
}

/** Path to the run.sh script for a bench type, relative to the repo root. */
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
