/**
 * Assist-tool registration (Group 4).
 *
 * Exposes the three assist tools two ways so Group 2's coordinator and Group 6's
 * pipeline can consume whichever fits:
 *   - {@link assistTools}: a plain {@link AssistTools} facade the pipeline calls
 *     directly (`assistTools.judge(...)`).
 *   - {@link createAssistToolSet}: an AI SDK `ToolSet` the coordinator registers
 *     so the model can invoke the enhancer, judge, and survey as agent-to-agent
 *     tools. Registering them here is what makes them show up — and log — every
 *     time the coordinator reaches for one.
 *
 * The registered tools carry the same zod-validated contracts as the underlying
 * functions; each `execute` delegates to the function (which does the logging).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runPromptEnhancer, type EnhanceDeps } from "./prompt-enhancer.js";
import { runJudge, type JudgeDeps } from "./judge.js";
import { runSurvey, type SurveyDeps } from "./survey.js";
import type { AssistTools, JudgeInput, PromptEnhancerInput, SurveyInput } from "./types.js";

/** The assist tools as a plain facade the pipeline calls directly. */
export const assistTools: AssistTools = {
  enhancePrompt: (input) => runPromptEnhancer(input),
  judge: (input) => runJudge(input),
  survey: (input) => runSurvey(input),
};

const graphContextSchema = z
  .object({
    impactedFiles: z
      .array(z.object({ path: z.string(), reason: z.string(), rank: z.number().optional() }))
      .optional(),
    symbols: z
      .array(z.object({ name: z.string(), file: z.string(), line: z.number().optional() }))
      .optional(),
    coverage: z.number().optional(),
  })
  .optional();

const surveyQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(z.object({ label: z.string(), recommended: z.boolean().optional() })),
  allowFreeText: z.boolean(),
  multiSelect: z.boolean().optional(),
});

export interface AssistToolDeps {
  enhance?: EnhanceDeps;
  judge?: JudgeDeps;
  survey?: SurveyDeps;
}

/**
 * Build the AI SDK tool set the coordinator registers. Pass per-tool deps to wire
 * in a working directory, memory, or (in tests) injected model calls/prompters.
 */
export function createAssistToolSet(deps: AssistToolDeps = {}): ToolSet {
  return {
    prompt_enhancer: tool({
      description:
        "Enhance an incomplete prompt with code-graph context, rate its complexity, and " +
        "recommend the cheapest capable model. Call at step 1 when completeness is below " +
        "threshold and the gap is recoverable from context (not a developer-only decision).",
      inputSchema: z.object({
        rawPrompt: z.string(),
        completenessScore: z.number().optional(),
        graphContext: graphContextSchema,
      }),
      execute: (input: PromptEnhancerInput) => runPromptEnhancer(input, deps.enhance),
    }),
    judge: tool({
      description:
        "The quality gate (step 5). Evaluate the diff plus the evidence of done and return a " +
        "pass/fail verdict with notes. judgeModel MUST differ from workerModel.",
      inputSchema: z.object({
        diff: z.string(),
        evidence: z.array(z.string()).optional(),
        definitionOfDone: z.string().optional(),
        workerModel: z.string(),
        judgeModel: z.string(),
      }),
      execute: (input: JudgeInput) => runJudge(input, deps.judge),
    }),
    user_survey: tool({
      description:
        "Ask the developer a short set of focused clarifying questions (≤3) when context is " +
        "genuinely missing and the developer is the best source. Every question offers a " +
        "free-text answer. Do not ask when a best practice or recoverable context answers it.",
      inputSchema: z.object({
        reason: z.string(),
        questions: z.array(surveyQuestionSchema).max(3),
      }),
      execute: (input: SurveyInput) => runSurvey(input, deps.survey),
    }),
  };
}
