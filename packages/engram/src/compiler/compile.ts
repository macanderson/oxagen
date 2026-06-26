/**
 * compile() — the top-level context compilation orchestrator.
 *
 * This is the core Phase B function. It:
 * 1. Runs all retrieval engines in parallel
 * 2. Fuses and ranks candidates
 * 3. Fetches pinned procedural rules
 * 4. Packs under budget (knapsack)
 * 5. Layouts for cache stability
 *
 * Always-on. No feature flags. If it fails, the caller's catch handler
 * falls back to legacy context assembly.
 */
import type { EpisodicStore } from "../store/episodic";
import type { TaskFrame, RetrievalEngine, RetrievalQuery } from "../retrieval/types";
import { fuseAndRank, type FusionWeights, DEFAULT_WEIGHTS } from "../retrieval/fusion";
import { pack, type TokenBudget, type PackResult } from "./packer";
import { buildLayout, type ContextWindow } from "./layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** Retrieval engines to run. */
  engines: RetrievalEngine[];
  /** Episodic store for fetching pinned records. */
  store: EpisodicStore;
  /** System prompt to include in position 0. */
  systemPrompt?: string;
  /** Fusion weights (defaults to uniform). */
  fusionWeights?: FusionWeights;
  /** Max candidates per engine. Default: 20. */
  candidatesPerEngine?: number;
  /** Diversity constraint for packer. Default: 3. */
  diversityConstraint?: number;
}

// ---------------------------------------------------------------------------
// Budget computation
// ---------------------------------------------------------------------------

/** Default budget assumptions by model family. */
const MODEL_BUDGETS: Record<string, number> = {
  openai: 128000,
  anthropic: 200000,
  google: 1000000,
  default: 128000,
};

/**
 * Compute a token budget from the model ID.
 * Reserves space for system prompt, procedural rules, and working memory.
 */
export function computeBudget(modelId: string): TokenBudget {
  const family = resolveFamily(modelId);
  const total = MODEL_BUDGETS[family] ?? MODEL_BUDGETS["default"]!;

  // Reserve proportional amounts
  const system = Math.min(2000, Math.floor(total * 0.02));
  const procedural = Math.min(4000, Math.floor(total * 0.04));
  const working = Math.min(8000, Math.floor(total * 0.08));
  const volatile = total - system - procedural - working;

  return {
    total,
    reserved: { system, procedural, volatile, working },
  };
}

function resolveFamily(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("openai")) return "openai";
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  return "default";
}

// ---------------------------------------------------------------------------
// compile()
// ---------------------------------------------------------------------------

/**
 * Compile a context window for the given task frame and budget.
 *
 * This is the function that makes agents faster and sharper. Call it once
 * per turn to get a budget-respecting, cache-stable context window.
 */
export async function compile(
  taskFrame: TaskFrame,
  budget: TokenBudget,
  options: CompileOptions,
): Promise<ContextWindow> {
  const startMs = Date.now();
  const candidatesPerEngine = options.candidatesPerEngine ?? 20;
  const diversityConstraint = options.diversityConstraint ?? 3;

  // 1. Build retrieval query from task frame
  const query: RetrievalQuery = {
    namespace: taskFrame.namespace,
    taskDescription: taskFrame.taskDescription,
    workingSet: taskFrame.workingSet,
    recentEventIds: taskFrame.recentEventIds,
    limit: candidatesPerEngine,
  };

  // 2. Run all retrieval engines in parallel
  const retrievalStart = Date.now();
  const engineResults = await Promise.all(
    options.engines.map((engine) =>
      engine.retrieve(query).catch(() => [] as Awaited<ReturnType<RetrievalEngine["retrieve"]>>),
    ),
  );
  const retrievalMs = Date.now() - retrievalStart;

  const totalCandidates = engineResults.reduce((sum, r) => sum + r.length, 0);

  // 3. Fuse and rank
  const fused = fuseAndRank(engineResults, options.fusionWeights ?? DEFAULT_WEIGHTS);

  // 4. Get pinned procedural records (salience = 1.0)
  const pinned = await options.store
    .query({
      namespace: taskFrame.namespace,
      kinds: ["procedural"],
      minSalience: 1.0,
      limit: 50,
    })
    .catch(() => []);

  // 5. Pack under budget
  const packStart = Date.now();
  const packResult: PackResult = pack({
    candidates: fused,
    budget,
    pinnedRecords: pinned,
    diversityConstraint,
    modelId: taskFrame.modelId,
  });
  const packingMs = Date.now() - packStart;

  // 6. Layout for cache stability
  const layoutStart = Date.now();
  const window = buildLayout({
    included: packResult.included,
    compressed: packResult.compressed,
    pinned,
    systemPrompt: options.systemPrompt ?? "",
    modelId: taskFrame.modelId,
    tokenUsage: packResult.tokenUsage,
    metadata: {
      compiledAt: Date.now(),
      retrievalMs,
      packingMs,
      layoutMs: 0, // Filled after
      totalMs: 0,
      candidatesRetrieved: totalCandidates,
      candidatesPacked: packResult.included.length,
      candidatesCompressed: packResult.compressed.length,
      candidatesEvicted: packResult.evicted.length,
    },
  });
  const layoutMs = Date.now() - layoutStart;

  // Patch timing into metadata
  window.metadata.layoutMs = layoutMs;
  window.metadata.totalMs = Date.now() - startMs;

  return window;
}
