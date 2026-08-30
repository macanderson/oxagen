/**
 * Eager pipeline-role model resolution for the TUI's MODELS readout.
 *
 * The engine resolves the planner/evaluator, worker, and judge models lazily —
 * inside the turn, after a prompt is submitted — but every input to that
 * resolution (defaults, env overrides, the pinned worker slug) is known the
 * moment the REPL mounts. This mirrors the engine's own resolution so the TUI
 * can show which models WILL run before the first prompt is typed, instead of
 * dashes until the first turn routes:
 *
 *   - worker  — the REPL pins the executor via `runTurn({ model })`, so the
 *               resolved `resolveModelId()` slug is exactly what will run.
 *   - judge   — `pickAdvisorModel(worker)` (or the `OXAGEN_JUDGE_PANEL`
 *               cross-vendor panel), same call the pipeline makes.
 *   - planner — `OXAGEN_LLM_EVALUATOR` or the local heuristic (the engine's
 *               evaluator default; see agent-engine's evaluate/evaluator.ts).
 *
 * Stage events during a turn still overwrite these with the engine-reported
 * actuals (see telemetry.ts), so a drift here can never stick past the first
 * turn — but there should be none: keep this aligned with the engine.
 */
import {
  pickAdvisorModel,
  pickJudgePanel,
  LOCAL_EVALUATOR,
} from "@oxagen/agent-engine";
import { writeSettingsValue } from "../settings/write.js";
import type { TelemetryModels } from "./telemetry.js";

/** The three configurable pipeline roles, as named by the `/…-model` commands. */
export type ModelRole = "worker" | "judge" | "triage";

/** Role → the `.oxagen/settings.json` key that persists it. */
const ROLE_SETTINGS_KEY: Record<ModelRole, string> = {
  worker: "workerModel",
  judge: "judgeModel",
  triage: "triageModel",
};

/**
 * Persist a per-role model to the LOCAL settings scope (`.oxagen/settings.local.json`)
 * so the choice survives across sessions — on next launch `applySettingsToEnv`
 * projects it into the env var the engine reads. The CURRENT session takes effect
 * via the caller threading the slug explicitly into the next turn (no process.env
 * mutation here — the run-time override stays an explicit argument, not global
 * state). Returns the settings file path written.
 */
export function persistRoleModel(
  role: ModelRole,
  slug: string,
  cwd?: string,
): string {
  return writeSettingsValue({
    scope: "local",
    key: ROLE_SETTINGS_KEY[role],
    value: slug,
    cwd,
  });
}

/**
 * Explicit per-role model overrides chosen at runtime (e.g. via `/triage-model`
 * / `/judge-model`), which take precedence over the env/heuristic defaults.
 * `triage` drives the planner + evaluator; `judge` drives the advisor/panel.
 */
export interface ModelRoleOverrides {
  triage?: string | undefined;
  judge?: string | undefined;
}

/**
 * Resolve the triage(planner)/worker/judge slugs the pipeline will use for a
 * given `worker` slug. Explicit `overrides` (from a live `/…-model` command)
 * win; otherwise we mirror the engine's own env/heuristic resolution so the
 * readout matches what will actually run.
 */
export function resolveModelRoles(
  worker: string,
  overrides: ModelRoleOverrides = {},
): TelemetryModels {
  const planner =
    overrides.triage ?? process.env["OXAGEN_LLM_EVALUATOR"] ?? LOCAL_EVALUATOR;
  const judge =
    overrides.judge ??
    (process.env["OXAGEN_JUDGE_PANEL"]
      ? `panel(${pickJudgePanel(worker)
          .map((m) => m.split("/").pop())
          .join(",")})`
      : pickAdvisorModel(worker));
  return { planner, worker, judge };
}
