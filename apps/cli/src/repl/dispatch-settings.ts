/**
 * dispatch-settings.ts — read/persist the REPL's Dispatch-mode preferences
 * (docs/specs/repl-async-dispatch.md §3.6).
 *
 * The mode toggle and concurrency cap live in the same tiered `settings.json`
 * the REPL already reads (settings/schema.ts), so they round-trip across REPL
 * restarts exactly like the model-role pins (`workerModel`, …) and
 * `confirmScope`. Writes target the LOCAL scope (`.oxagen/settings.local.json`)
 * — the per-machine, non-committed tier — mirroring `persistRoleModel`.
 *
 * Kept tiny and side-effect-light so it unit-tests without a TTY and the REPL
 * can seed its state synchronously at mount.
 */
import { loadSettings } from "../settings/resolve.js";
import { writeSettingsValue } from "../settings/write.js";

/** Default concurrency cap when the user hasn't pinned one. */
export const DISPATCH_DEFAULT_CAP = 4;

export interface DispatchSettings {
  /** Whether Dispatch mode is ON. */
  mode: boolean;
  /** Max concurrent background dispatches before local queueing. */
  maxConcurrent: number;
}

/** Resolve the persisted Dispatch-mode preferences for `cwd` (defaults applied). */
export function loadDispatchSettings(cwd: string): DispatchSettings {
  const settings = loadSettings({ cwd }).settings;
  const cap = settings.dispatchMaxConcurrent;
  return {
    mode: settings.dispatchMode === true,
    maxConcurrent:
      typeof cap === "number" && cap > 0
        ? Math.floor(cap)
        : DISPATCH_DEFAULT_CAP,
  };
}

/** Persist the Dispatch-mode toggle to the local settings scope. Returns the file path. */
export function persistDispatchMode(on: boolean, cwd: string): string {
  return writeSettingsValue({
    scope: "local",
    key: "dispatchMode",
    value: String(on),
    cwd,
  });
}

/** Persist the concurrency cap to the local settings scope. Returns the file path. */
export function persistDispatchCap(n: number, cwd: string): string {
  return writeSettingsValue({
    scope: "local",
    key: "dispatchMaxConcurrent",
    value: String(Math.max(1, Math.floor(n))),
    cwd,
  });
}
