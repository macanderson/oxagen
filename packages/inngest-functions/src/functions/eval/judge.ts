import { generateObjectFor, selectModel, type ModelMessage } from "@oxagen/ai";
import type { Surface } from "@oxagen/telemetry";
import {
  evalJudgeScoreSchema,
  type EvalJudgeScore,
} from "@oxagen/oxagen/contracts/eval-schema";

// LLM-as-judge scoring for Evals v1. The rubric is deliberately tight and
// wedge-aligned: correctness measures agreement with the expected answer;
// faithfulness measures grounding in any cited context (the graph-grounding
// moat) and defaults to 1 when no citation is required. The call runs through
// @oxagen/ai's generateObjectFor, so the judge's own tokens land in the metering
// pipe exactly like every other LLM call.

const RUBRIC = [
  "You are a strict, impartial evaluation judge scoring one AI answer.",
  "Score three axes, each a number in [0,1]:",
  "- correctness: how well the answer matches the expected answer. When no",
  "  expected answer is given, judge factual/logical soundness and how well it",
  "  addresses the input.",
  "- faithfulness: how well the answer is grounded in any cited context or",
  "  sources present in the answer. If the answer cites nothing and the task",
  "  needs no citation, return 1.",
  "- score: the overall quality in [0,1], weighing correctness most heavily.",
  "Also return a one- or two-sentence rationale. Be terse and specific. Do not",
  "reward verbosity or confident-sounding but wrong answers.",
].join("\n");

export interface JudgeArgs {
  input: string;
  expectedOutput: string | null;
  output: string;
  /** Resolved gateway model id for the judge. */
  judgeModelId: string;
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    messageId: string | null;
  };
}

export interface JudgeResult {
  score: EvalJudgeScore;
  usage: { promptTokens: number; completionTokens: number };
}

/** Score one target output with the LLM judge. */
export async function scoreWithJudge(args: JudgeArgs): Promise<JudgeResult> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        `INPUT:\n${args.input}`,
        args.expectedOutput != null
          ? `EXPECTED ANSWER:\n${args.expectedOutput}`
          : "EXPECTED ANSWER: (none provided — judge on soundness)",
        `ANSWER TO SCORE:\n${args.output}`,
      ].join("\n\n"),
    },
  ];

  const { object, usage } = await generateObjectFor({
    schema: evalJudgeScoreSchema,
    system: RUBRIC,
    messages,
    model: selectModel({ model: args.judgeModelId }),
    telemetry: args.telemetry,
  });

  return {
    score: object,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    },
  };
}
