/**
 * Pure telemetry reducer for the full-screen TUI's live-stats dock (MODELS /
 * TURN / TOOLS panels — token/cost numbers come straight from the existing
 * metrics bus and session `usage` state, so they aren't duplicated here).
 *
 * Fed entirely from data the pipeline already emits via `onStage` /
 * `onToolCall` (see agent-engine's RunTurnOptions) — nothing new is plumbed
 * from the engine. Model slugs for the planner/coordinator (evaluator),
 * worker (executor), and judge (advisor) are recovered from the existing
 * `StageEvent.label`/`.detail` conventions the pipeline already writes (see
 * packages/agent-engine/src/pipeline/index.ts's evaluate/route/judge
 * `onStage` calls) — no engine change needed. Framework-free and fully
 * unit-testable, same as scroll.ts.
 */
import type { StageEvent } from "../agent/trace.js";

/** Mirrors packages/agent-engine/src/engine.ts's `opts.maxSteps ?? 256` default — the
 *  REPL never passes an explicit `maxSteps`, so this is the live cap in practice. */
export const ENGINE_DEFAULT_MAX_STEPS = 256;

/** The six tools the TOOLS panel always shows, in display order; anything else tallies under "other". */
export const TRACKED_TOOLS = [
  "code_graph",
  "edit_file",
  "write_file",
  "read_file",
  "bash",
  "grep",
] as const;
export type TrackedTool = (typeof TRACKED_TOOLS)[number];
/** Bucket key for any tool call outside {@link TRACKED_TOOLS} (list_dir, glob, subagent dispatch, MCP tools…). */
export const OTHER_TOOLS_KEY = "other";

export interface TelemetryModels {
  /** The cheap evaluator that scores/refines the prompt before routing. */
  planner?: string;
  /** The executor model actually doing the work this turn. */
  worker?: string;
  /** The advisor judging completeness. */
  judge?: string;
}

export interface TelemetryTurn {
  /** Current pipeline stage; "idle" before the first turn / between turns. */
  phase: StageEvent["kind"] | "idle";
  /** Tool calls so far this turn — a live proxy for the engine's own step counter. */
  step: number;
  /** Display cap for `step` — see {@link ENGINE_DEFAULT_MAX_STEPS}. */
  maxStep: number;
  /** How many revise rounds have started this turn. */
  reviseRound: number;
  /** Epoch ms the current turn started; null when idle. */
  turnStartedAt: number | null;
}

export interface TelemetryState {
  models: TelemetryModels;
  turn: TelemetryTurn;
  /** Session-cumulative call counts, keyed by tool name (never reset between turns). */
  tools: Record<string, number>;
}

export const INITIAL_TELEMETRY_STATE: TelemetryState = {
  models: {},
  turn: {
    phase: "idle",
    step: 0,
    maxStep: ENGINE_DEFAULT_MAX_STEPS,
    reviseRound: 0,
    turnStartedAt: null,
  },
  tools: {},
};

export type TelemetryAction =
  | { type: "turn-start"; at: number }
  | { type: "stage"; stage: StageEvent }
  | { type: "tool-call"; name: string }
  | { type: "turn-end" }
  /**
   * Overwrite the MODELS readout with eagerly-resolved slugs (at REPL mount and
   * on `/model`), so the panel is populated before the first turn instead of
   * showing dashes. Stage events later overwrite with engine-reported actuals.
   */
  | { type: "seed-models"; models: TelemetryModels };

/**
 * Pulls the evaluator/planner model slug from an "evaluate" {@link StageEvent}'s
 * `detail` — the engine writes either the short model slug or the literal
 * string "heuristic" there (fallback path, no live model to report).
 */
export function parseEvaluatorModel(stage: StageEvent): string | undefined {
  if (stage.kind !== "evaluate") return undefined;
  if (!stage.detail || stage.detail === "heuristic") return undefined;
  return stage.detail;
}

/** Pulls the executor/worker model slug out of a "route" StageEvent's label — `model · tier (slug)`. */
export function parseWorkerModel(stage: StageEvent): string | undefined {
  if (stage.kind !== "route") return undefined;
  const m = /\(([^()]+)\)\s*$/.exec(stage.label);
  return m?.[1];
}

/** Pulls the judge/advisor model slug out of a "judge" StageEvent's detail — `advisor: slug` (optionally trailing " (heuristic)"). */
export function parseJudgeModel(stage: StageEvent): string | undefined {
  if (stage.kind !== "judge") return undefined;
  const m = /^advisor:\s*(\S+)/.exec(stage.detail ?? "");
  return m?.[1];
}

/** Bucket a tool name into one of {@link TRACKED_TOOLS} or {@link OTHER_TOOLS_KEY}. */
export function toolBucket(name: string): string {
  return (TRACKED_TOOLS as readonly string[]).includes(name)
    ? name
    : OTHER_TOOLS_KEY;
}

/** Pure reducer — mirrors the shape of scroll.ts's `scrollReducer`. */
export function telemetryReducer(
  state: TelemetryState,
  action: TelemetryAction,
): TelemetryState {
  switch (action.type) {
    case "turn-start":
      return {
        ...state,
        turn: {
          phase: "evaluate",
          step: 0,
          maxStep: state.turn.maxStep,
          reviseRound: 0,
          turnStartedAt: action.at,
        },
      };
    case "stage": {
      const { stage } = action;
      const models: TelemetryModels = { ...state.models };
      const planner = parseEvaluatorModel(stage);
      if (planner) models.planner = planner;
      const worker = parseWorkerModel(stage);
      if (worker) models.worker = worker;
      const judge = parseJudgeModel(stage);
      if (judge) models.judge = judge;
      return {
        ...state,
        models,
        turn: {
          ...state.turn,
          phase: stage.kind,
          reviseRound:
            stage.kind === "revise"
              ? state.turn.reviseRound + 1
              : state.turn.reviseRound,
        },
      };
    }
    case "tool-call": {
      const key = toolBucket(action.name);
      return {
        ...state,
        turn: { ...state.turn, step: state.turn.step + 1 },
        tools: { ...state.tools, [key]: (state.tools[key] ?? 0) + 1 },
      };
    }
    case "turn-end":
      return { ...state, turn: { ...state.turn, phase: "complete" } };
    case "seed-models":
      return { ...state, models: { ...state.models, ...action.models } };
    default:
      return state;
  }
}
