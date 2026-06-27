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
  /** Whether OXAGEN_MODEL was set from settings.model. */
  model: boolean;
}

/**
 * Project `env`, `apiUrl`, and `model` from the resolved settings into
 * `process.env` (filling only unset vars). Call once at CLI startup. Returns
 * what was applied (useful for `--verbose` / diagnostics).
 */
export function applySettingsToEnv(opts: ResolveSettingsOptions = {}): AppliedSettingsEnv {
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

  let model = false;
  if (settings.model && isUnset("OXAGEN_MODEL")) {
    process.env["OXAGEN_MODEL"] = settings.model;
    model = true;
  }

  return { envKeys, apiUrl, model };
}
