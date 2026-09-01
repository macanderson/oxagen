/**
 * Prompt evaluator — the front-of-pipeline coordinator.
 *
 * Before the expensive coding model ever sees a prompt, the evaluator reads it
 * and reports back:
 *   - completeness: is this actionable on its own, or is it missing what/where/done?
 *   - complexity:   how much work / risk / blast-radius does it imply?
 *   - a recommended tier for the executor,
 *   - the symbols / files / topics worth pulling from the code graph,
 *   - a refined prompt with filler removed and intent sharpened (meaning intact),
 *   - and its chain of thought.
 *
 * The default evaluator is `"local"` — the deterministic cost-router heuristic,
 * no model call at all — so coordination costs nothing and works with zero
 * cloud dependencies (including the CLI's Anthropic-only BYOK mode). Set
 * `OXAGEN_LLM_EVALUATOR` to a model slug (e.g. a Haiku tier) to re-enable
 * LLM-based evaluation. It NEVER blocks a turn: if a model call fails, the
 * same heuristic keeps the pipeline moving.
 *
 * Unlike the CLI version this does NOT call `generateObject` from `ai` directly —
 * it takes an {@link AgentAi} port so the platform can wire in its metered
 * implementation and the CLI wires in a BYOK implementation.
 */
import { z } from "zod";
import { classifyTier, accumulateUsage } from "../router/model-router";
import { emptyUsage } from "../types";
import { isFatalAuthOrBillingError } from "../model-errors";
import type { AgentAi } from "../ports";
import type { PromptEvaluation } from "../trace/types";

/**
 * The sentinel evaluator "model": run the deterministic local heuristic instead
 * of an LLM call. The default coordinator.
 */
export const LOCAL_EVALUATOR = "local";

/** The evaluator model slug, or `"local"` for the heuristic coordinator. */
function evaluatorModel(override?: string): string {
  return override ?? process.env["OXAGEN_LLM_EVALUATOR"] ?? LOCAL_EVALUATOR;
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
      "YOU are choosing the actual worker model that will build this, and it costs real " +
        "money. Pick the CHEAPEST tier that still delivers a correct, high-quality result " +
        "— lean cheap, never overspend: 'fast' mechanical/single-file, 'balanced' normal " +
        "feature work, 'precise' auth/billing/security/migration/architecture or wide blast-radius.",
    ),
  missing: z
    .array(z.string())
    .describe(
      "Specific information the prompt lacks to be fully actionable. Empty if none.",
    ),
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
    .describe(
      "Phrases removed from the original because they add no value. Empty if none.",
    ),
  reasoning: z
    .string()
    .describe(
      "2–4 sentence explanation of the scores and what context will help.",
    ),
});

export interface EvaluatePromptOptions {
  prompt: string;
  /** Override the evaluator model slug (otherwise the local heuristic). */
  model?: string;
  signal?: AbortSignal;
}

const EVALUATOR_SYSTEM = [
  "You are the evaluation stage of an agentic coding system. A coding agent is about",
  "to act on the user's prompt against a real repository. Your job is to triage it.",
  "",
  "Score it plainly:",
  "- completeness: can the agent act on this WITHOUT guessing? Penalize missing files,",
  "  undefined terms, and 'fix it' with no symptom. Reward concrete targets and acceptance.",
  "- complexity: estimate the work, risk, and blast radius — not the prompt's length.",
  "",
  "Then help the agent succeed:",
  "- recommendedTier: YOU choose the worker model that builds this, and it spends real",
  "  money. Pick the CHEAPEST tier that still produces a correct, high-quality result —",
  "  lean cheap and escalate only when the task truly needs it. Reserve 'precise' for",
  "  auth, billing, security, migrations, schema, or architecture.",
  "- contextQueries: name the exact symbols/files/topics the agent should pull from the",
  "  code graph so it skips blind exploration. Prefer real identifiers and paths.",
  "- refinedPrompt: rewrite for the agent. Strip filler and contradiction; keep 100% of the",
  "  actual intent and every constraint. Do NOT add requirements the user did not state.",
].join("\n");

/**
 * Build the deterministic heuristic evaluation — used as the `"local"`
 * coordinator (the default) and as the fallback when an LLM evaluator call
 * fails. Uses the cost router so the tier is still sensible, and never mutates
 * the prompt (a deterministic path must not risk dropping intent).
 */
function heuristicEvaluation(
  prompt: string,
  model: string,
  fallback: boolean,
): PromptEvaluation {
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
    reasoning: fallback
      ? `Heuristic evaluation (model unavailable): ${route.rationale}.`
      : `Local heuristic evaluation: ${route.rationale}.`,
    fallback,
    model,
    usage: emptyUsage(),
  };
}

/**
 * Evaluate a prompt with the cheap model. Returns the model's structured read, or
 * a heuristic fallback for a transient failure — the pipeline should make
 * progress rather than dying on a hiccup. A FATAL auth/billing error is the
 * exception: it re-throws instead of falling back, because every later model
 * call (route, execute, judge) would fail identically — falling back here would
 * just waste a doomed evaluate→enhance→route detour before the same error
 * surfaces at execute. Failing fast here gets the real message to the user
 * immediately instead of after a delay.
 *
 * @param opts  - Evaluation options (prompt, optional model override, abort signal).
 * @param ai    - Injected AI port. The platform wires in a metered implementation;
 *                the CLI wires in a BYOK one.
 */
export async function evaluatePrompt(
  opts: EvaluatePromptOptions,
  ai: AgentAi,
): Promise<PromptEvaluation> {
  const model = evaluatorModel(opts.model);
  // The local coordinator: deterministic heuristic, no model call. Not a
  // fallback — it's the chosen (default) evaluation path.
  if (model === LOCAL_EVALUATOR) {
    return heuristicEvaluation(opts.prompt, model, false);
  }
  try {
    const { object, usage } = await ai.generateObject({
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
  } catch (err) {
    if (isFatalAuthOrBillingError(err)) throw err;
    return heuristicEvaluation(opts.prompt, model, true);
  }
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
