/**
 * Assist-tool contracts (pipeline Group 4).
 *
 * The coordinator (Group 2) calls three agent-to-agent helpers at the edges of a
 * turn: `prompt_enhancer` and `user_survey` at step 1 (close the gap in an
 * incomplete prompt) and `judge` at step 5 (the quality gate). These are the
 * request/response shapes for those tools.
 *
 * Group 7 ships the canonical `contracts/*.ts` interfaces every group implements
 * against. Until that lands on `main`, Group 4 mirrors the slice it needs here so
 * it builds and tests standalone; the shapes are kept identical to the Group 7
 * `tools.ts`/`context.ts` stubs. Group 6 reconciles the two when it wires the
 * 5-step pipeline.
 */

/** How much work / risk / blast-radius a request implies. */
export type Complexity = "trivial" | "low" | "medium" | "high" | "very_high";

/**
 * The structural subset of Group 3's `GraphResult` the enhancer consumes. Group 3
 * (the context layer) owns the full type; depending only on this subset lets the
 * enhancer accept graph context without a hard build dependency on unlanded code.
 */
export interface GraphImpactedFile {
  path: string;
  reason: string;
  rank?: number;
}
export interface GraphSymbolRef {
  name: string;
  file: string;
  line?: number;
}
export interface GraphContext {
  impactedFiles?: GraphImpactedFile[];
  symbols?: GraphSymbolRef[];
  /** 0..1 — how much of the query the graph could answer. */
  coverage?: number;
}

// ── prompt_enhancer (step 1) ─────────────────────────────────────────────────
export interface PromptEnhancerInput {
  rawPrompt: string;
  /** 0..1 completeness score from step 1's evaluator (lower = more to enhance). */
  completenessScore?: number;
  /** Structured JSON context from `graph_query` (Group 3). */
  graphContext?: GraphContext;
}
export interface PromptEnhancerOutput {
  enhancedPrompt: string;
  complexity: Complexity;
  /** Cheapest model capable of the work, as a gateway slug. */
  recommendedModel: string;
  /** Human-readable context lines that were folded into the prompt. */
  addedContext: string[];
  rationale: string;
}

// ── judge (step 5) ───────────────────────────────────────────────────────────
export interface JudgeInput {
  diff: string;
  /** Test logs, build logs, output files, screenshots. */
  evidence?: string[];
  definitionOfDone?: string;
  workerModel: string;
  /** MUST differ from `workerModel`; enforced at runtime. */
  judgeModel: string;
}
export interface JudgeOutput {
  verdict: "pass" | "fail";
  /** 0..1 quality score. */
  score: number;
  /** Actionable notes to loop on when verdict = fail. */
  notes: string;
  gaps: string[];
}

// ── user_survey (step 1) ─────────────────────────────────────────────────────
export interface SurveyOption {
  label: string;
  /** Marks the best-practice default so the developer can accept it fast. */
  recommended?: boolean;
}
export interface SurveyQuestion {
  id: string;
  prompt: string;
  options: SurveyOption[];
  /** Every question accepts free text; the tool normalizes this to `true`. */
  allowFreeText: boolean;
  multiSelect?: boolean;
}
export interface SurveyInput {
  /** Why the developer is the best source for this gap. */
  reason: string;
  /** Kept to `config.survey.maxQuestions` or fewer. */
  questions: SurveyQuestion[];
}
export interface SurveyAnswer {
  questionId: string;
  value: string;
  source: "option" | "free_text";
}
export interface SurveyOutput {
  answers: SurveyAnswer[];
}

/** The assist tools the coordinator calls. Group 6 wires these into the pipeline. */
export interface AssistTools {
  enhancePrompt(input: PromptEnhancerInput): Promise<PromptEnhancerOutput>;
  /** Throws {@link JudgeSameModelError} if judgeModel === workerModel. */
  judge(input: JudgeInput): Promise<JudgeOutput>;
  survey(input: SurveyInput): Promise<SurveyOutput>;
}

/** The three assist tools, for the debug-log stream. */
export type ToolName = "prompt-enhancer" | "judge" | "survey";
/** Every assist tool emits start, then exactly one of done/skipped. */
export type ToolStatus = "start" | "done" | "skipped";
