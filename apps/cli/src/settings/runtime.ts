/**
 * runtime.ts — Glue that makes `settings.json` drive the running CLI.
 *
 * The model and apiUrl resolvers (model.ts, config.ts) and the gateway key
 * resolver (agent/env.ts) already consult environment variables. Rather than
 * thread settings through each of them, we project the relevant settings into
 * `process.env` once at startup — and only for vars the shell has not already
 * set, so an explicit `OXAGEN_MODEL=… oxagen` or a shell export always wins.
 *
 * This keeps the wiring additive and cycle-free: those resolvers are untouched,
 * yet `settings.json` now feeds them.
 */
import { loadSettings, type ResolveSettingsOptions } from "./resolve.js";

/** True when an env var is effectively unset (so settings may fill it). */
function isUnset(name: string): boolean {
  const v = process.env[name];
  return v === undefined || v === "";
}

export interface AppliedSettingsEnv {
  /** Names of env vars populated from settings.env. */
  envKeys: string[];
  /** Whether OXAGEN_API_URL was set from settings.apiUrl. */
  apiUrl: boolean;
  /** Whether OXAGEN_MODEL was set from settings.workerModel ?? settings.model. */
  model: boolean;
  /** Whether OXAGEN_LLM_ADVISOR was set from settings.judgeModel. */
  judgeModel: boolean;
  /** Whether OXAGEN_LLM_EVALUATOR was set from settings.triageModel. */
  triageModel: boolean;
}

/**
 * Project `env`, `apiUrl`, and the per-role model slugs from the resolved
 * settings into `process.env` (filling only unset vars). Call once at CLI
 * startup. Returns what was applied (useful for `--verbose` / diagnostics).
 *
 * Per-role model mapping (each fills the env var the engine already reads):
 *   - worker  → OXAGEN_MODEL          (workerModel ?? model)
 *   - judge   → OXAGEN_LLM_ADVISOR    (judgeModel)
 *   - triage  → OXAGEN_LLM_EVALUATOR  (triageModel) — also drives the planner
 *               via the CLI runtime, which reads triageModel directly.
 */
export function applySettingsToEnv(
  opts: ResolveSettingsOptions = {},
): AppliedSettingsEnv {
  const { settings } = loadSettings(opts);
  const envKeys: string[] = [];

  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (isUnset(key)) {
      process.env[key] = value;
      envKeys.push(key);
    }
  }

  let apiUrl = false;
  if (settings.apiUrl && isUnset("OXAGEN_API_URL")) {
    process.env["OXAGEN_API_URL"] = settings.apiUrl;
    apiUrl = true;
  }

  // Worker: an explicit workerModel wins over the generic `model` default.
  let model = false;
  const workerSlug = settings.workerModel ?? settings.model;
  if (workerSlug && isUnset("OXAGEN_MODEL")) {
    process.env["OXAGEN_MODEL"] = workerSlug;
    model = true;
  }

  let judgeModel = false;
  if (settings.judgeModel && isUnset("OXAGEN_LLM_ADVISOR")) {
    process.env["OXAGEN_LLM_ADVISOR"] = settings.judgeModel;
    judgeModel = true;
  }

  let triageModel = false;
  if (settings.triageModel && isUnset("OXAGEN_LLM_EVALUATOR")) {
    process.env["OXAGEN_LLM_EVALUATOR"] = settings.triageModel;
    triageModel = true;
  }

  return { envKeys, apiUrl, model, judgeModel, triageModel };
}
