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
 * Always-on. No feature flags.
 */
import type { EpisodicStore } from "../store/episodic";
import type {
  TaskFrame,
  RetrievalEngine,
  RetrievalQuery,
} from "../retrieval/types";
import {
  fuseAndRank,
  type FusionWeights,
  DEFAULT_WEIGHTS,
} from "../retrieval/fusion";
import { pack, type TokenBudget, type PackResult } from "./packer";
import { buildLayout, type ContextWindow } from "./layout";
import { resolveFamily } from "./model-family";
import { resolveActivePins } from "../api/pin";

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
  /**
   * Optional error sink. Invoked (best-effort) whenever a retrieval engine or
   * the pinned-record query rejects, so a caller can wire a logger without this
   * pure compiler taking a hard logging dependency. Never throws control flow:
   * a rejected retrieval still degrades to an empty result, and the failure
   * count is also surfaced in `metadata.retrievalFailures`.
   */
  onError?: (err: unknown, context: { phase: string; engine?: string }) => void;
  /**
   * Per-engine retrieval timeout in ms. A single hung engine (a stuck Neo4j
   * driver, a slow embedding call) must not stall the whole turn, so each
   * engine races this deadline and a timeout degrades to an empty result plus a
   * recorded failure — exactly like a rejection. Default: 2000ms.
   */
  retrievalTimeoutMs?: number;
}

/** One recorded retrieval failure, collected during compile for observability. */
interface RetrievalFailure {
  engine?: string;
  error: string;
}

/** Sentinel thrown when an engine exceeds {@link CompileOptions.retrievalTimeoutMs}. */
class RetrievalTimeoutError extends Error {
  constructor(engine: string, ms: number) {
    super(`retrieval engine "${engine}" exceeded ${ms}ms timeout`);
    this.name = "RetrievalTimeoutError";
  }
}

/**
 * Race a retrieval against a deadline. Resolves to the engine's result if it
 * settles first; rejects with {@link RetrievalTimeoutError} on timeout. The
 * timer is always cleared so a slow-but-eventual engine can't leak a handle.
 */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  engine: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RetrievalTimeoutError(engine, ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
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

  // Collect retrieval failures so a dropped engine / dropped pinned-record
  // query is observable (count surfaced in metadata) rather than silent. The
  // pinned-record loss is especially costly — those are MUST-include
  // salience-1.0 procedural rules.
  const retrievalFailures: RetrievalFailure[] = [];

  // 2. Run all retrieval engines in parallel, each under its own timeout so one
  //    hung engine can't stall the turn (S-5).
  const retrievalTimeoutMs = options.retrievalTimeoutMs ?? 2000;
  const retrievalStart = Date.now();
  const engineResults = await Promise.all(
    options.engines.map((engine) =>
      withTimeout(
        engine.retrieve(query),
        retrievalTimeoutMs,
        engine.name,
      ).catch((err: unknown) => {
        retrievalFailures.push({ engine: engine.name, error: String(err) });
        options.onError?.(err, {
          phase: "engine-retrieve",
          engine: engine.name,
        });
        return [] as Awaited<ReturnType<RetrievalEngine["retrieve"]>>;
      }),
    ),
  );
  const retrievalMs = Date.now() - retrievalStart;

  const totalCandidates = engineResults.reduce((sum, r) => sum + r.length, 0);

  // 3. Fuse and rank
  const fused = fuseAndRank(
    engineResults,
    options.fusionWeights ?? DEFAULT_WEIGHTS,
  );

  // 4. Get pinned procedural records (salience = 1.0)
  const pinnedRaw = await options.store
    .query({
      namespace: taskFrame.namespace,
      kinds: ["procedural"],
      minSalience: 1.0,
      limit: 50,
    })
    .catch((err: unknown) => {
      // Losing pinned procedural records silently drops MUST-include
      // salience-1.0 rules — record and surface it, then degrade to none.
      retrievalFailures.push({ error: String(err) });
      options.onError?.(err, { phase: "pinned-query" });
      return [];
    });

  // 4b. Honor unpin: a procedural record whose newest pin/unpin marker is an
  //     unpin must be suppressed (M-3). Fetch recent episodic markers and let
  //     the latest event per rule decide. Fail-open (keep all pinned) if the
  //     marker query rejects, so a store hiccup never silently drops rules.
  let pinned = pinnedRaw;
  if (pinnedRaw.length > 0) {
    const markers = await options.store
      .query({
        namespace: taskFrame.namespace,
        kinds: ["episodic"],
        limit: 500,
      })
      .catch((err: unknown) => {
        retrievalFailures.push({ error: String(err) });
        options.onError?.(err, { phase: "pin-marker-query" });
        return [];
      });
    pinned = resolveActivePins(pinnedRaw, markers);
  }

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

  // 6. Layout for cache stability. Only render pinned rules the packer actually
  //    kept — a pinned rule the packer had to truncate (budget overflow) must
  //    not reappear in the procedural section.
  const includedIds = new Set(packResult.included.map((r) => r.id));
  const effectivePinned = pinned.filter((p) => includedIds.has(p.id));
  const layoutStart = Date.now();
  const window = buildLayout({
    included: packResult.included,
    compressed: packResult.compressed,
    pinned: effectivePinned,
    systemPrompt: options.systemPrompt ?? "",
    modelId: taskFrame.modelId,
    tokenUsage: packResult.tokenUsage,
    pinnedTruncated: packResult.pinnedTruncated,
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
      retrievalFailures: retrievalFailures.length,
      pinnedTruncated: packResult.pinnedTruncated,
      contentTruncated: 0, // Filled by buildLayout
    },
  });
  const layoutMs = Date.now() - layoutStart;

  // Patch timing into metadata
  window.metadata.layoutMs = layoutMs;
  window.metadata.totalMs = Date.now() - startMs;

  return window;
}
