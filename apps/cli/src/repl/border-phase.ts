/**
 * Pure derivation + color math for the prompt input's turn-lifecycle border
 * animation:
 *   - IDLE (no active turn, or the last turn just completed): cyan.
 *   - EVALUATING (submit → the pipeline's EVALUATE stage still running): a
 *     rapid rainbow flash — red → fuchsia → orange → repeat.
 *   - ACTIVE (evaluate done — enhance/route/execute/judge/revise running):
 *     solid amber.
 *
 * Derives from the SAME `TelemetryTurn.phase` the TURN dock panel already
 * tracks (telemetry.ts) rather than dispatching a second, parallel phase —
 * telemetry.ts's reducer already sets `phase: "evaluate"` on submit
 * (turn-start), advances it to whatever stage.kind onStage reports next, and
 * sets `phase: "complete"` on turn-end, which is exactly the submit ->
 * evaluate -> active -> idle sequence this animation needs. Reading the same
 * state instead of adding a new one means the dock and the border can never
 * drift out of sync with each other.
 *
 * Framework-free and fully unit-testable — no Ink, no timers — same
 * philosophy as scroll.ts / telemetry.ts.
 */
import { theme } from "../tui/theme.js";
import type { MotionMode } from "../lib/config.js";
import type { TelemetryTurn } from "./telemetry.js";

export type BorderPhase = "idle" | "evaluating" | "active";

/**
 * `idle`/`complete` (no turn, or the turn that just ended) -> idle;
 * `evaluate` (submit through the coordinator's completeness check) ->
 * evaluating; every other in-flight stage (enhance/route/execute/judge/
 * revise) -> active. A stage this doesn't recognize (future stage kinds)
 * degrades to `active` — treated as "the turn is doing SOMETHING" rather
 * than silently falling back to idle mid-turn.
 */
export function borderPhaseFor(turnPhase: TelemetryTurn["phase"]): BorderPhase {
  switch (turnPhase) {
    case "idle":
    case "complete":
      return "idle";
    case "evaluate":
      return "evaluating";
    default:
      return "active";
  }
}

/** Rainbow flash cycle order. */
export const RAINBOW_FLASH_COLORS: readonly string[] = [
  theme.red,
  theme.fuchsia,
  theme.orange,
];

/** Flash frame interval, ms — a "rapid flash" per the design (110-130ms band). */
export const RAINBOW_FLASH_INTERVAL_MS = 120;

/**
 * The flash color at a given tick — an incrementing frame counter (NOT a
 * timestamp), so the caller's interval driving `tick` can use any cadence
 * and this stays a pure, trivially-testable function of "which frame". `tick`
 * wraps via modulo, so it's safe to increment forever without overflow concern
 * in practice (Number.MAX_SAFE_INTEGER frames at 120ms is >33,000 years).
 */
export function rainbowColorAt(tick: number): string {
  const colors = RAINBOW_FLASH_COLORS;
  return colors[((tick % colors.length) + colors.length) % colors.length]!;
}

/** Resolve the prompt input border's accent color for a phase + flash tick. */
export function borderColorFor(phase: BorderPhase, tick: number): string {
  switch (phase) {
    case "idle":
      return theme.cyan;
    case "active":
      return theme.amber;
    case "evaluating":
      return rainbowColorAt(tick);
  }
}

/**
 * Motion-aware border color: at "full" the border animates as designed; at
 * "reduced"/"off" the rainbow flash is suppressed — an in-flight turn
 * (evaluating included) renders the static active amber, so the border still
 * communicates busy-vs-idle without ever animating.
 */
export function promptBorderColorFor(
  phase: BorderPhase,
  tick: number,
  motion: MotionMode,
): string {
  if (motion === "full") return borderColorFor(phase, tick);
  return phase === "idle" ? theme.cyan : theme.amber;
}
