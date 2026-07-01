/**
 * prompt_enhancer — pipeline step 1 (Group 4).
 *
 * Takes a raw prompt, folds in context (Group 3's graph result plus the CLI's
 * local code graph and recalled memory), then rewrites the prompt so it is
 * complete, rates its complexity, and recommends the cheapest capable model.
 *
 * Two layers of context, LLM optional:
 *   1. Gather — deterministic, no network. Graph context passed by the caller
 *      (Group 3) is turned into `addedContext` lines, and the local code-graph
 *      enhancer ({@link gatherLocalContext}) resolves symbols/paths named in the
 *      prompt. This alone already grounds the agent.
 *   2. Rewrite — one structured model call folds that context into a sharper,
 *      self-contained prompt and rates complexity. If no gateway key is
 *      configured (or the call fails), it degrades to appending the gathered
 *      context verbatim and a heuristic complexity — a turn always proceeds.
 *
 * The recommended model is computed in code, not trusted from the LLM: the
 * complexity maps to a tier, reconciled UP with the cost router's read of the
 * prompt so a high-stakes request is never under-spent. Cheapest capable wins.
 *
 * Every call is logged (start/done, or skipped when the pipeline is off).
 */
import { generateObject } from "ai";
import { z } from "zod";
import { enhancePrompt as gatherLocalContext } from "../agent/prompt-enhancer.js";
import { classifyTier, modelForTier } from "../agent/model-router.js";
import { ensureGatewayKey } from "../agent/env.js";
import type { ModelTier } from "../agent/fleet/types.js";
import type { FleetMemory } from "../agent/fleet/memory.js";
import { readAssistConfig, type AssistPipelineConfig } from "./config.js";
import { logTool } from "./logging.js";
import type {
  Complexity,
  GraphContext,
  PromptEnhancerInput,
  PromptEnhancerOutput,
} from "./types.js";

/** Complexity → the cheapest tier capable of that work. */
const COMPLEXITY_TIER: Record<Complexity, ModelTier> = {
  trivial: "fast",
  low: "fast",
  medium: "balanced",
  high: "precise",
  very_high: "precise",
};
/** Tier → representative complexity, for the router-reconciliation floor. */
const TIER_COMPLEXITY: Record<ModelTier, Complexity> = {
  fast: "low",
  balanced: "medium",
  precise: "high",
};
const COMPLEXITY_RANK: Record<Complexity, number> = {
  trivial: 0,
  low: 1,
  medium: 2,
  high: 3,
  very_high: 4,
};

/** The higher of two complexities (never under-rate a risky task). */
function maxComplexity(a: Complexity, b: Complexity): Complexity {
  return COMPLEXITY_RANK[a] >= COMPLEXITY_RANK[b] ? a : b;
}

const enhanceSchema = z.object({
  enhancedPrompt: z
    .string()
    .describe(
      "The prompt rewritten to be complete and self-contained: intent sharpened, the " +
        "retrieved context folded in as concrete file/symbol references. Preserve the user's meaning.",
    ),
  complexity: z
    .enum(["trivial", "low", "medium", "high", "very_high"])
    .describe(
      "How much work / risk / blast-radius the request implies. 'trivial' = one-line/mechanical; " +
        "'high'/'very_high' = auth, billing, security, migrations, or architectural change.",
    ),
  addedContext: z
    .array(z.string())
    .describe("Short bullets naming the context you folded in (files, symbols, prior lessons)."),
  rationale: z
    .string()
    .describe("1–2 sentences on what you added and why this complexity rating."),
});

const ENHANCER_SYSTEM = [
  "You are the prompt-enhancement stage of an agentic coding pipeline. You receive a raw",
  "user prompt plus context already retrieved from the code graph and past work. Your job:",
  "rewrite the prompt so an executing agent can act without re-discovering context, rate the",
  "complexity honestly, and name what you added.",
  "",
  "Rules:",
  "- Fold the provided context in as concrete references (real file paths and symbols). Do not",
  "  invent files or symbols that were not provided.",
  "- Preserve the user's intent exactly; sharpen it, never change the ask.",
  "- Rate complexity by the WORK implied, not the prompt's length.",
].join("\n");

export interface EnhanceDeps {
  /** Working directory for local code-graph lookups (default `process.cwd()`). */
  cwd?: string;
  /** Fleet memory to recall past lessons from. */
  memory?: FleetMemory | null;
  signal?: AbortSignal;
  /** Injected structured-output model call (defaults to the AI SDK). */
  generate?: typeof generateObject;
  /** Injected clock, for deterministic `ms=` in logs/tests. */
  now?: () => number;
  /** Injected config (defaults to {@link readAssistConfig}). */
  config?: AssistPipelineConfig;
}

/** Turn Group 3's graph result into human-readable `addedContext` bullets. */
function graphContextLines(graph?: GraphContext): string[] {
  if (!graph) return [];
  const lines: string[] = [];
  for (const f of graph.impactedFiles ?? []) {
    lines.push(`Impacted file: ${f.path}${f.reason ? ` — ${f.reason}` : ""}`);
  }
  for (const s of graph.symbols ?? []) {
    lines.push(`Symbol: ${s.name} (${s.file}${s.line ? `:${s.line}` : ""})`);
  }
  return lines;
}

/**
 * Run the prompt_enhancer tool. Always returns a {@link PromptEnhancerOutput};
 * on skip or model failure it returns a best-practice passthrough with a logged
 * decision rather than throwing.
 */
export async function runPromptEnhancer(
  input: PromptEnhancerInput,
  deps: EnhanceDeps = {},
): Promise<PromptEnhancerOutput> {
  const config = deps.config ?? readAssistConfig();
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();
  const threshold = config.promptEnhancement.minAcceptableScore;
  const score = input.completenessScore;

  // Router's structural read of the raw prompt — used both as the complexity
  // floor and as the fallback complexity when the LLM is unavailable.
  const routedTier = classifyTier({ text: input.rawPrompt }).tier;
  const routedComplexity = TIER_COMPLEXITY[routedTier];

  const enhancerOff = !config.enabled || !config.promptEnhancement.enabled;
  if (enhancerOff) {
    await logTool({ tool: "prompt-enhancer", step: 1, status: "skipped" }, [
      ["reason", config.enabled ? "enhancer disabled" : "pipeline off"],
    ]);
    // Best-practice default: hand back the raw prompt with a router-derived
    // complexity and the cheapest capable model, so the turn proceeds.
    return {
      enhancedPrompt: input.rawPrompt,
      complexity: routedComplexity,
      recommendedModel: modelForTier(routedTier),
      addedContext: [],
      rationale: "Prompt enhancement skipped (pipeline off); using best-practice defaults.",
    };
  }

  const startReason =
    score === undefined
      ? "no completeness score"
      : `completeness ${score} < ${threshold}`;
  await logTool({ tool: "prompt-enhancer", step: 1, status: "start" }, [["reason", startReason]]);

  const startedAt = now();

  // ── Layer 1: gather context deterministically ──────────────────────────────
  const addedContext = graphContextLines(input.graphContext);
  let localContextBlock = "";
  try {
    const local = await gatherLocalContext({
      prompt: input.rawPrompt,
      cwd,
      memory: deps.memory ?? null,
    });
    localContextBlock = local.context;
    for (const resolved of local.resolved) addedContext.push(`Resolved in code graph: ${resolved}`);
    for (const record of local.lessons) {
      if (record.lesson) addedContext.push(`Lesson: ${record.lesson}`);
    }
  } catch {
    /* code graph unavailable — enhancement is best-effort */
  }

  const graphBlock =
    addedContext.length > 0
      ? `## Retrieved context\n${addedContext.map((l) => `- ${l}`).join("\n")}`
      : "";
  const gatheredContext = [graphBlock, localContextBlock].filter(Boolean).join("\n\n");

  // ── Layer 2: rewrite with one model call (optional) ────────────────────────
  let enhancedPrompt = gatheredContext
    ? `${input.rawPrompt}\n\n${gatheredContext}`
    : input.rawPrompt;
  let complexity: Complexity = routedComplexity;
  let rationale = "Context appended without a model rewrite (heuristic complexity).";
  let tokens = 0;
  const generate = deps.generate ?? generateObject;

  if (ensureGatewayKey(cwd)) {
    try {
      const { object, usage } = await generate({
        model: modelForTier("fast"),
        schema: enhanceSchema,
        system: ENHANCER_SYSTEM,
        prompt: [
          `## Raw prompt\n${input.rawPrompt}`,
          gatheredContext ? `\n${gatheredContext}` : "",
          score !== undefined ? `\n## Completeness score\n${score} (threshold ${threshold})` : "",
        ].join("\n"),
        abortSignal: deps.signal,
      });
      enhancedPrompt = object.enhancedPrompt || enhancedPrompt;
      complexity = object.complexity;
      rationale = object.rationale;
      // Merge the model's context bullets with the ones we already resolved.
      for (const c of object.addedContext) if (c && !addedContext.includes(c)) addedContext.push(c);
      tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    } catch {
      /* model unavailable — keep the gathered-context passthrough above */
    }
  }

  // Reconcile complexity UP with the router so a high-stakes prompt is never
  // under-rated, then pick the cheapest capable model for that complexity.
  complexity = maxComplexity(complexity, routedComplexity);
  const recommendedModel = modelForTier(COMPLEXITY_TIER[complexity]);

  await logTool({ tool: "prompt-enhancer", step: 1, status: "done" }, [
    ["result", "enhanced"],
    ["complexity", complexity],
    ["recommend_model", recommendedModel],
    ["tokens", tokens],
    ["ms", now() - startedAt],
  ]);

  return { enhancedPrompt, complexity, recommendedModel, addedContext, rationale };
}
