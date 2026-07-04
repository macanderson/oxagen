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
import { pickAdvisorModel, pickJudgePanel, LOCAL_EVALUATOR } from "@oxagen/agent-engine";
import type { TelemetryModels } from "./telemetry.js";

/** Resolve the planner/worker/judge slugs the pipeline will use for `worker`. */
export function resolveModelRoles(worker: string): TelemetryModels {
  const planner = process.env["OXAGEN_LLM_EVALUATOR"] ?? LOCAL_EVALUATOR;
  const judge = process.env["OXAGEN_JUDGE_PANEL"]
    ? `panel(${pickJudgePanel(worker)
        .map((m) => m.split("/").pop())
        .join(",")})`
    : pickAdvisorModel(worker);
  return { planner, worker, judge };
}
