/**
 * judge — pipeline step 5, the quality gate (Group 4).
 *
 * After the work is qualified (step 4), the judge re-reads the diff plus the
 * evidence of done and rules on whether the work actually meets the definition of
 * done. It is the gate: a `fail` verdict loops the pipeline back to step 3 with
 * the notes; a `pass` lets the turn complete.
 *
 * The judge MUST run on a model different from the worker that produced the diff.
 * A model grading its own work grades itself generously; independence is the whole
 * point. The coordinator passes both models and this tool enforces the rule —
 * {@link JudgeSameModelError} if they match when `mustDifferFromWorker` is on.
 *
 * Like the enhancer, the model call is optional: if no gateway key is configured
 * (or the call fails) the judge degrades to a conservative heuristic so a model
 * outage never wedges the gate. Every call is logged (start/done, or skipped when
 * the pipeline is off).
 */
import { generateObject } from "ai";
import { z } from "zod";
import { ensureGatewayKey } from "../agent/env.js";
import { readAssistConfig, type AssistPipelineConfig } from "./config.js";
import { logTool } from "./logging.js";
import type { JudgeInput, JudgeOutput } from "./types.js";

/** Thrown when the judge would run on the same model that did the work. */
export class JudgeSameModelError extends Error {
  constructor(model: string) {
    super(
      `Judge refused: judgeModel must differ from workerModel (both are "${model}"). ` +
        "A model cannot independently grade its own work.",
    );
    this.name = "JudgeSameModelError";
  }
}

const verdictSchema = z.object({
  verdict: z
    .enum(["pass", "fail"])
    .describe(
      "'pass' ONLY if the diff plus evidence fully satisfy the definition of done. " +
        "If any part is partial, unverified, or described-but-not-done, this is 'fail'.",
    ),
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("0..1 quality score. 1 = complete and well-executed; below 0.5 = clearly incomplete."),
  notes: z
    .string()
    .describe("Actionable notes. When 'fail', say exactly what to finish so the loop can act."),
  gaps: z
    .array(z.string())
    .describe("Concrete gaps between what was asked and what the diff/evidence show. Empty on pass."),
});

const JUDGE_SYSTEM = [
  "You are a skeptical quality gate auditing another AI agent's coding work. Agents",
  "routinely claim completion while the work is half-done: they describe edits without",
  "making them, leave TODOs, skip promised tests, or finish only part of the request.",
  "Your job is to catch exactly that. Default to skepticism and judge the WORK, not the prose.",
  "",
  "You are given the diff, the evidence of done (test/build logs, output files, screenshots),",
  "and the definition of done. Mark 'pass' ONLY when every part of the definition of done is",
  "met by concrete, verifiable changes in the diff and backed by the evidence. A confident",
  "summary with no matching diff or evidence is a red flag, not proof.",
].join("\n");

function evidenceBlock(input: JudgeInput): string {
  const evidence =
    input.evidence && input.evidence.length > 0
      ? input.evidence.map((e) => `  - ${e}`).join("\n")
      : "  (none provided)";
  return [
    `## Definition of done\n${input.definitionOfDone ?? "(not specified — infer from the diff)"}`,
    `## Diff\n${input.diff || "(empty diff — the agent changed nothing)"}`,
    `## Evidence of done\n${evidence}`,
  ].join("\n\n");
}

/**
 * Conservative verdict for when the judge model is unavailable. An empty diff
 * fails outright; otherwise it abstains to a low-confidence pass so a model
 * outage never permanently blocks the gate.
 */
function heuristicVerdict(input: JudgeInput): JudgeOutput {
  if (!input.diff.trim()) {
    return {
      verdict: "fail",
      score: 0,
      notes: "Heuristic gate (judge model unavailable): the diff is empty — no work to accept.",
      gaps: ["No changes were made."],
    };
  }
  return {
    verdict: "pass",
    score: 0.5,
    notes: "Heuristic gate (judge model unavailable): a non-empty diff was produced; not model-verified.",
    gaps: [],
  };
}

export interface JudgeDeps {
  /** Working directory used to locate the gateway key (default `process.cwd()`). */
  cwd?: string;
  signal?: AbortSignal;
  /** Injected structured-output model call (defaults to the AI SDK). */
  generate?: typeof generateObject;
  /** Injected clock, for deterministic `ms=` in logs/tests. */
  now?: () => number;
  /** Injected config (defaults to {@link readAssistConfig}). */
  config?: AssistPipelineConfig;
}

/**
 * Run the judge tool. Enforces the different-model rule, then evaluates the diff.
 * Always returns a {@link JudgeOutput} except when the different-model rule is
 * violated, which throws {@link JudgeSameModelError}.
 */
export async function runJudge(input: JudgeInput, deps: JudgeDeps = {}): Promise<JudgeOutput> {
  const config = deps.config ?? readAssistConfig();
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();

  const judgeOff = !config.enabled || !config.judge.enabled;
  if (judgeOff) {
    await logTool({ tool: "judge", step: 5, status: "skipped" }, [
      ["reason", config.enabled ? "judge disabled" : "pipeline off"],
    ]);
    // No gate when the pipeline is off: nothing judges the work, so it passes
    // through. The skip is logged so the developer knows the gate did not run.
    return {
      verdict: "pass",
      score: 1,
      notes: "Judge skipped (pipeline off); work not gated.",
      gaps: [],
    };
  }

  // Enforce the different-model rule before doing any work.
  if (config.judge.mustDifferFromWorker && input.judgeModel === input.workerModel) {
    throw new JudgeSameModelError(input.judgeModel);
  }

  await logTool({ tool: "judge", step: 5, status: "start" }, [
    ["worker_model", input.workerModel],
    ["judge_model", input.judgeModel],
    ["reason", "qualify diff"],
  ]);

  const startedAt = now();
  let result: JudgeOutput = heuristicVerdict(input);
  let tokens = 0;
  const generate = deps.generate ?? generateObject;

  if (ensureGatewayKey(cwd)) {
    try {
      const { object, usage } = await generate({
        model: input.judgeModel,
        schema: verdictSchema,
        system: JUDGE_SYSTEM,
        prompt: evidenceBlock(input),
        abortSignal: deps.signal,
      });
      result = {
        verdict: object.verdict,
        score: Math.max(0, Math.min(1, object.score)),
        notes: object.notes,
        gaps: object.gaps,
      };
      tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    } catch {
      /* judge model unavailable — keep the heuristic verdict above */
    }
  }

  await logTool({ tool: "judge", step: 5, status: "done" }, [
    ["verdict", result.verdict],
    ["score", result.score],
    ["tokens", tokens],
    ["ms", now() - startedAt],
  ]);

  return result;
}
