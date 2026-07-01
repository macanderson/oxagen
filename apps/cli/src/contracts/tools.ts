/**
 * Assist-tool contract surface (pipeline Group 4 — already shipped) plus the
 * fresh `plan` tool (pipeline Group 6 — not yet built).
 *
 * Re-exports the real `prompt_enhancer`/`judge`/`user_survey` IO types and
 * `AssistTools` from `pipeline/index.ts` as the canonical Group 4 contract, so
 * there is exactly one of each in the codebase.
 *
 * The original stub's `AssistTools` also declared a fourth method —
 * `plan(input): Promise<PlanOutput>`. The shipped Group 4 `AssistTools` ships
 * only `enhancePrompt`/`judge`/`survey`; `plan` belongs to pipeline step 3
 * ("do the work"), which is Group 6's territory and has not landed. `PlanTask`
 * / `PlanInput` / `PlanOutput` below are therefore fresh, standalone Group 6
 * stubs — referenced by `./pipeline.ts`'s `Pipeline.doWork`, but deliberately
 * NOT folded into the re-exported `AssistTools`, so that interface stays
 * exactly what Group 4 shipped. See the PR description's "Reconciliation
 * notes".
 *
 * The stub's `ToolLogMeta` (`{tool,status,model?,tokens?,ms?,reason?}`) also
 * disagrees with the shipped debug-log shape: `pipeline/logging.ts` ships
 * `ToolEvent` (`{tool,step,status}`) plus an ordered `LogField` tuple list for
 * the remaining fields. Re-exported as shipped; see "Reconciliation notes".
 */
export type {
  AssistTools,
  JudgeInput,
  JudgeOutput,
  LogField,
  PromptEnhancerInput,
  PromptEnhancerOutput,
  SurveyAnswer,
  SurveyInput,
  SurveyOption,
  SurveyOutput,
  SurveyQuestion,
  ToolEvent,
  ToolName,
  ToolStatus,
} from "../pipeline/index.js";

// ---- plan (step 3) — fresh Group 6 stub. Not yet built; not part of the
// shipped Group 4 `AssistTools` (see file header). ----

export interface PlanTask {
  id: string;
  title: string;
  dependsOn?: string[];
}

export interface PlanInput {
  objective: string;
  enhancedPrompt?: string;
  graphImpactedFiles?: string[];
}

export interface PlanOutput {
  tasks: PlanTask[];
}
