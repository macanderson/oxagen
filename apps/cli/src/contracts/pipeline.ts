/**
 * 5-step pipeline state machine contract (pipeline Group 6 — not yet built).
 *
 * The quality gate: score prompt completeness (enhance or survey to close the
 * gap), pick a model, do the work (planning first for non-trivial work),
 * qualify the evidence, then judge with a model that must differ from the
 * worker — looping back to step 3 on a fail.
 *
 * Fresh, standalone stub: imports the tool/router/orchestrator types it
 * references from this package's own reconciled re-exports (`./tools.js`,
 * `./router.js`, `./orchestrator.js`) rather than `src/pipeline`'s state
 * machine (which does not exist in this worktree — only the assist tools have
 * landed), so this file type-checks with no build dependency on unlanded code.
 */
import type { JudgeOutput, PlanOutput, PromptEnhancerOutput, SurveyOutput } from "./tools.js";
import type { RoutingDecision } from "./router.js";
import type { WorkerResult } from "./orchestrator.js";

export type PipelineStep = 1 | 2 | 3 | 4 | 5;

export interface StepResult {
  step: PipelineStep;
  status: "done" | "skipped" | "looped";
  detail: string;
}

export interface PipelineRunInput {
  rawPrompt: string;
}

export interface PipelineRunResult {
  steps: StepResult[];
  /** True only after the judge passes. */
  taskComplete: boolean;
  judge?: JudgeOutput;
}

export interface Pipeline {
  // Step 1: score completeness, then enhance or survey to close the gap.
  //   - recoverable / best practice -> enhancePrompt
  //   - real developer decision     -> survey
  //   - already complete            -> skip, still log
  evaluatePrompt(input: PipelineRunInput): Promise<PromptEnhancerOutput | SurveyOutput | null>;

  // Step 2: rate complexity and pick the model (cheapest capable).
  selectModel(): RoutingDecision;

  // Step 3: do the work. Complex work goes through the plan tool first.
  doWork(plan?: PlanOutput): Promise<WorkerResult>;

  // Step 4: qualify the work. When verifyWork is true, evidence is mandatory.
  //   Screenshots required when an impacted screen is reachable.
  qualify(result: WorkerResult): Promise<{ ok: boolean; evidence: string[] }>;

  // Step 5: judge. judgeModel !== workerModel. On fail, loop back to step 3.
  gate(result: WorkerResult): Promise<JudgeOutput>;

  // Runs all five steps and enforces the gate.
  run(input: PipelineRunInput): Promise<PipelineRunResult>;
}
