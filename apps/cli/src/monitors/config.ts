/**
 * Background-monitor config (pipeline Group 5).
 *
 * Matches `monitor-tools.json -> config.monitors` exactly:
 *
 *   monitors.askBeforeMonitoring  (default true)  — the coordinator asks the
 *     developer before dispatching a monitor (the coordinator does the asking;
 *     this module only exposes the flag).
 *   monitors.dispatchOnPullRequest (default true) — dispatch when a PR is created.
 *   monitors.dispatchOnCiFix       (default true) — dispatch when a CI-fix
 *     request or a GH Actions run triggered by a fix is in flight.
 *   monitors.pollIntervalSeconds   (default 30)   — poll cadence.
 *
 * Precedence for every key: explicit env override → `config.json`'s
 * `monitors` patch (`~/.config/oxagen/config.json`, layered by Group 6 into
 * the unified pipeline config) → the baked-in default below. Env wins so a
 * developer (or CI) can retarget behavior for a whole shell without editing
 * config.
 */
import { readConfig } from "../lib/config.js";

/** Group 5's config slice, fully resolved (no optional fields). */
export interface MonitorsConfig {
  askBeforeMonitoring: boolean;
  dispatchOnPullRequest: boolean;
  dispatchOnCiFix: boolean;
  pollIntervalSeconds: number;
}

/** A partial override written into `config.json` under `monitors`. */
export type MonitorsConfigPatch = Partial<MonitorsConfig>;

export const DEFAULT_MONITORS_CONFIG: MonitorsConfig = {
  askBeforeMonitoring: true,
  dispatchOnPullRequest: true,
  dispatchOnCiFix: true,
  pollIntervalSeconds: 30,
};

/** Env vars, in the order the config keys above are declared. */
export const ASK_ENV = "OXAGEN_MONITORS_ASK";
export const ON_PR_ENV = "OXAGEN_MONITORS_ON_PR";
export const ON_CI_FIX_ENV = "OXAGEN_MONITORS_ON_CI_FIX";
export const POLL_SECONDS_ENV = "OXAGEN_MONITORS_POLL_SECONDS";

/** Parse a boolean env var. `"1"`/`"true"` → true, `"0"`/`"false"` → false. */
function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/** Parse a non-negative numeric env var. */
function envNumber(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const parsed = Number(v);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Whether the coordinator must ask before dispatching a monitor. */
export function getAskBeforeMonitoring(): boolean {
  return (
    envBool(ASK_ENV) ??
    readConfig().monitors?.askBeforeMonitoring ??
    DEFAULT_MONITORS_CONFIG.askBeforeMonitoring
  );
}

/** Whether pull-request creation is a dispatch trigger. */
export function getDispatchOnPullRequest(): boolean {
  return (
    envBool(ON_PR_ENV) ??
    readConfig().monitors?.dispatchOnPullRequest ??
    DEFAULT_MONITORS_CONFIG.dispatchOnPullRequest
  );
}

/** Whether a CI-fix request / fix-triggered GH Actions run is a dispatch trigger. */
export function getDispatchOnCiFix(): boolean {
  return (
    envBool(ON_CI_FIX_ENV) ??
    readConfig().monitors?.dispatchOnCiFix ??
    DEFAULT_MONITORS_CONFIG.dispatchOnCiFix
  );
}

/** The poll cadence, in seconds. */
export function getPollIntervalSeconds(): number {
  return (
    envNumber(POLL_SECONDS_ENV) ??
    readConfig().monitors?.pollIntervalSeconds ??
    DEFAULT_MONITORS_CONFIG.pollIntervalSeconds
  );
}

/**
 * True when a newly created pull request should trigger a monitor dispatch.
 * The coordinator calls this at the point it learns a PR was created; the
 * caller is still responsible for the ask-first prompt when
 * {@link getAskBeforeMonitoring} is true.
 */
export function shouldDispatchForPullRequest(): boolean {
  return getDispatchOnPullRequest();
}

/**
 * True when a CI-fix request (or a GH Actions run triggered by a fix) should
 * trigger a monitor dispatch. Same ask-first caveat as
 * {@link shouldDispatchForPullRequest}.
 */
export function shouldDispatchForCiFix(): boolean {
  return getDispatchOnCiFix();
}
