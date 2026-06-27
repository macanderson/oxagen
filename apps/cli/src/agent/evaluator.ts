/**
 * Prompt evaluator — the cheap front-of-pipeline model call.
 *
 * Before the expensive coding model ever sees a prompt, a small, fast model
 * (Haiku by default) reads it and reports back:
 *   - completeness: is this actionable on its own, or is it missing what/where/done?
 *   - complexity:   how much work / risk / blast-radius does it imply?
 *   - a recommended tier for the executor,
 *   - the symbols / files / topics worth pulling from the code graph,
 *   - a refined prompt with filler removed and intent sharpened (meaning intact),
 *   - and its chain of thought.
 *
 * This is what lets the CLI spend Haiku money to decide how to spend Opus money,
 * and to enrich a vague prompt before acting on it. It NEVER blocks a turn: if
 * the model call fails, a transparent heuristic fallback (the deterministic cost
 * router) keeps the pipeline moving.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { classifyTier, modelForTier, accumulateUsage } from "./model-router.js";
import { emptyUsage } from "./fleet/types.js";
import type { PromptEvaluation } from "./trace.js";

/** A tier's evaluator-model slug, overridable to track gateway drift. */
function evaluatorModel(override?: string): string {
  return (
    override ??
    process.env["OXAGEN_LLM_EVALUATOR"] ??
    modelForTier("fast")
  );
}

const evalSchema = z.object({
  completeness: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "0–100. How complete/actionable is the prompt ON ITS OWN? 100 = names what " +
        "to change, where, and how to know it's done. Low = vague or missing key facts.",
    ),
  complexity: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "0–100. How much work/risk/blast-radius does this imply? Trivial one-liner ≈ 10; " +
        "multi-file feature ≈ 60; auth/billing/migration/architecture ≈ 90.",
    ),
  recommendedTier: z
    .enum(["fast", "balanced", "precise"])
    .describe(
      "Cheapest tier that can do the job: 'fast' mechanical/single-file, 'balanced' " +
        "normal feature work, 'precise' auth/billing/security/migration/architecture.",
    ),
  missing: z
    .array(z.string())
    .describe("Specific information the prompt lacks to be fully actionable. Empty if none."),
  contextQueries: z
    .array(z.string())
    .describe(
      "Symbol names, file paths, or short topics worth retrieving from the repo's code " +
        "graph to ground the work (e.g. 'loginUser', 'src/auth/session.ts'). Empty if none.",
    ),
  refinedPrompt: z
    .string()
    .describe(
      "The prompt rewritten for the coding agent: remove pleasantries, hedging, and " +
        "redundancy; sharpen the ask. PRESERVE EVERY real requirement and constraint — " +
        "never invent, never drop intent. If the prompt is already tight, return it unchanged.",
    ),
  removed: z
    .array(z.string())
    .describe("Phrases removed from the original because they add no value. Empty if none."),
  reasoning: z
    .string()
    .describe("2–4 sentence explanation of the scores and what context will help."),
});

export interface EvaluatePromptOptions {
  prompt: string;
  /** Override the evaluator model slug (otherwise the fast tier). */
  model?: string;
  signal?: AbortSignal;
}

const EVALUATOR_SYSTEM = [
  "You are the evaluation stage of an agentic coding system. A coding agent is about",
  "to act on the user's prompt against a real repository. Your job is to triage it.",
  "",
  "Score it honestly:",
  "- completeness: can the agent act on this WITHOUT guessing? Penalize missing files,",
  "  undefined terms, and 'fix it' with no symptom. Reward concrete targets and acceptance.",
  "- complexity: estimate the work, risk, and blast radius — not the prompt's length.",
  "",
  "Then help the agent succeed:",
  "- recommendedTier: pick the CHEAPEST tier that can do the job well. Reserve 'precise'",
  "  for auth, billing, security, migrations, schema, or architecture.",
  "- contextQueries: name the exact symbols/files/topics the agent should pull from the",
  "  code graph so it skips blind exploration. Prefer real identifiers and paths.",
  "- refinedPrompt: rewrite for the agent. Strip filler and contradiction; keep 100% of the",
  "  actual intent and every constraint. Do NOT add requirements the user did not state.",
].join("\n");

/**
 * Build the deterministic heuristic evaluation used when the model is unavailable
 * or the call fails. Uses the cost router so the tier is still sensible, and never
 * mutates the prompt (a safe fallback must not risk dropping intent).
 */
function heuristicEvaluation(prompt: string, model: string): PromptEvaluation {
  const route = classifyTier({ text: prompt });
  const complexity =
    route.tier === "precise" ? 85 : route.tier === "balanced" ? 55 : 20;
  // Longer, more specific prompts are treated as more complete; very short asks less so.
  const len = prompt.trim().length;
  const completeness = len < 40 ? 45 : len < 160 ? 65 : 80;
  return {
    completeness,
    complexity,
    recommendedTier: route.tier,
    missing: [],
    contextQueries: [],
    refinedPrompt: prompt,
    removed: [],
    reasoning: `Heuristic evaluation (model unavailable): ${route.rationale}.`,
    fallback: true,
    model,
    usage: emptyUsage(),
  };
}

/**
 * Evaluate a prompt with the cheap model. Returns the model's structured read, or
 * a heuristic fallback that never throws — the pipeline must always make progress.
 */
export async function evaluatePrompt(
  opts: EvaluatePromptOptions,
): Promise<PromptEvaluation> {
  const model = evaluatorModel(opts.model);
  try {
    const { object, usage } = await generateObject({
      model,
      schema: evalSchema,
      system: EVALUATOR_SYSTEM,
      prompt: `Prompt to evaluate:\n${opts.prompt}`,
      abortSignal: opts.signal,
    });
    // A refined prompt that came back empty would silently drop the user's intent —
    // fall back to the original text in that case.
    const refinedPrompt = object.refinedPrompt.trim() || opts.prompt;
    return {
      completeness: clamp(object.completeness),
      complexity: clamp(object.complexity),
      recommendedTier: object.recommendedTier,
      missing: object.missing,
      contextQueries: object.contextQueries,
      refinedPrompt,
      removed: object.removed,
      reasoning: object.reasoning,
      fallback: false,
      model,
      usage: accumulateUsage(emptyUsage(), model, usage),
    };
  } catch {
    return heuristicEvaluation(opts.prompt, model);
  }
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
