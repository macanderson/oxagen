/**
 * Ask-versus-guess — the step-1 decision (Group 4).
 *
 * Avoid guessing where you can, but do not ask the developer a question when you
 * already have a clear best practice or the answer is recoverable from context.
 * Only ask about things the developer is genuinely the best source for, and only
 * when they are likely to answer well — a weak answer is worse than a sane
 * default.
 *
 * Decision order when a prompt is incomplete:
 *   1. Already complete (score ≥ threshold)      → skip, log.
 *   2. Recoverable from context (graph/repo/git)  → enhance (do not ask).
 *   3. A clear best practice fits                 → follow it, log the default.
 *   4. Developer unlikely to answer well          → follow the default, log it.
 *   5. A real decision the developer owns         → survey.
 *
 * Every branch that does NOT survey logs a `tool=survey status=skipped` line with
 * the reason (and the chosen default where one applies), so the developer can see
 * — and later override — the decision the agent made on their behalf.
 */
import { logTool } from "./logging.js";
import { readAssistConfig, type AssistPipelineConfig } from "./config.js";

export type ClarificationKind = "skip" | "enhance" | "default" | "survey";

export interface ClarificationDecision {
  kind: ClarificationKind;
  /** Machine reason, aligned with the survey-skip reason vocabulary. */
  reason: "already-complete" | "recoverable" | "best-practice" | "weak-answer-risk" | "developer-decision";
  /** The default the agent will proceed with, when it chose not to ask. */
  chosenDefault?: string;
}

export interface ClarificationSignals {
  /** 0..1 completeness of the raw prompt. */
  completenessScore: number;
  /** Override the completeness threshold (defaults to config). */
  threshold?: number;
  /** Can the gap be recovered from the graph/repo/config/git/env? */
  recoverableFromContext: boolean;
  /** A clear best-practice default, if one fits the gap. */
  bestPractice?: string;
  /** Is the developer likely to answer this well? Defaults to true. */
  developerLikelyToAnswerWell?: boolean;
  /** A sane fallback default to proceed with if we choose not to ask. */
  fallbackDefault?: string;
}

/**
 * Decide whether to skip, enhance, apply a default, or survey — and log the
 * non-survey outcomes as a survey skip. Returns the decision for the caller to
 * act on (call the enhancer, apply the default, or run the survey).
 */
export async function decideClarification(
  signals: ClarificationSignals,
  config: AssistPipelineConfig = readAssistConfig(),
): Promise<ClarificationDecision> {
  const threshold = signals.threshold ?? config.promptEnhancement.minAcceptableScore;
  const preferDefault = config.survey.preferBestPracticeOverAsking;
  const likely = signals.developerLikelyToAnswerWell ?? true;

  // 1. Already complete — no clarification needed.
  if (signals.completenessScore >= threshold) {
    await logTool({ tool: "survey", step: 1, status: "skipped" }, [["reason", "already-complete"]]);
    return { kind: "skip", reason: "already-complete" };
  }

  // 2. Recoverable from context — enhance instead of asking.
  if (signals.recoverableFromContext) {
    await logTool({ tool: "survey", step: 1, status: "skipped" }, [["reason", "recoverable"]]);
    return { kind: "enhance", reason: "recoverable" };
  }

  // 3. A clear best practice fits — follow it, log the default, do not ask.
  if (preferDefault && signals.bestPractice) {
    await logTool({ tool: "survey", step: 1, status: "skipped" }, [
      ["reason", "best-practice"],
      ["default", signals.bestPractice],
    ]);
    return { kind: "default", reason: "best-practice", chosenDefault: signals.bestPractice };
  }

  // 4. The developer is unlikely to answer well — a weak answer beats no default,
  //    but a sane default beats a weak answer. Proceed with the default.
  if (!likely) {
    const chosen = signals.bestPractice ?? signals.fallbackDefault ?? "sane default";
    await logTool({ tool: "survey", step: 1, status: "skipped" }, [
      ["reason", "weak-answer-risk"],
      ["default", chosen],
    ]);
    return { kind: "default", reason: "weak-answer-risk", chosenDefault: chosen };
  }

  // 5. A real decision the developer owns and no default fits — ask.
  return { kind: "survey", reason: "developer-decision" };
}
