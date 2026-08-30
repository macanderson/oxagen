/**
 * Automatic prompt enhancement — CLI adapter over the shared engine.
 *
 * Before a prompt is handed to the agent (or split into a plan), this enriches it
 * with the context the CLI already has about the repository: the code graph (a
 * local symbol + import index — where things are defined, what imports them) and
 * the fleet's recorded lessons. The user types "fix the login bug"; the agent
 * receives that plus the exact files and symbols involved and the gotchas it
 * learned last time. That is what makes the agent both faster (less blind
 * grepping) and cheaper (fewer exploratory tool calls before it acts).
 *
 * This is a thin adapter, not a second implementation. The candidate extraction,
 * the retrieval loop, and the semantic (embedding) fallback for conceptual
 * prompts live in exactly one place — @oxagen/agent-engine's
 * evaluate/prompt-enhancer.ts, the engine's injected-port version — and this
 * module's only job is translating the CLI's local types (a bare `cwd` string
 * and a synchronous {@link FleetMemory}) into the engine's CodeGraphProvider /
 * MemoryProvider ports and back, so orchestrator.ts and planner.ts keep their
 * existing call shape unchanged.
 *
 * The code graph is the knowledge graph the CLI carries offline; when the
 * platform knowledge graph is reachable it can augment this, but enhancement
 * never depends on the network and degrades to a no-op if the graph can't build.
 */
import {
  enhancePrompt as engineEnhancePrompt,
  type MemoryProvider,
} from "@oxagen/agent-engine";
import { queryCodeGraph } from "./code-graph.js";
import { createCodeGraphProvider } from "./adapters/code-graph-provider.js";
import {
  formatLessons,
  type FleetMemory,
  type MemoryRecord,
} from "./fleet/memory.js";
import type { ContextRetrieval } from "./trace.js";

export { extractCandidates } from "@oxagen/agent-engine";

export interface EnhanceOptions {
  prompt: string;
  cwd: string;
  /** Fleet memory to recall past lessons from (optional). */
  memory?: FleetMemory | null;
  /** Max distinct symbols/paths to look up (default 6). */
  maxSymbols?: number;
  /**
   * Extra retrieval hints (e.g. the evaluator's `contextQueries`): symbol names,
   * file paths, or topics. They are mined for candidates and looked up in the code
   * graph, but never appended to the visible prompt text — only what they resolve
   * to is injected.
   */
  extraQueries?: string[];
  /**
   * Code-graph query override (tests). Defaults to the real {@link queryCodeGraph},
   * which reads the on-disk DuckDB store and (for `semantic_search`) the gateway.
   */
  queryCodeGraph?: typeof queryCodeGraph;
}

export interface EnhanceResult {
  /** The original prompt with the retrieved context appended. */
  prompt: string;
  /** The retrieved context block alone (empty if nothing was found). */
  context: string;
  /** Symbol/path tokens that resolved to something in the code graph. */
  resolved: string[];
  /**
   * True when literal candidate lookups resolved little or nothing and a
   * semantic (embedding) search over the raw prompt was used instead. Lets a
   * conceptual prompt that names no exact symbol or path — e.g. "project level
   * configurations for the cli app" — still retrieve real files instead of
   * leaving the agent to blind grep.
   */
  usedSemanticFallback: boolean;
  /** Lessons recalled from fleet memory. */
  lessons: MemoryRecord[];
  /** Epoch ms context-gathering started. */
  startedAt: number;
  /** Epoch ms context-gathering finished. */
  finishedAt: number;
  /** Wall-clock ms spent gathering + injecting context. */
  durationMs: number;
  /** Which candidates were mined and which resolved (for verbose telemetry). */
  retrieval: ContextRetrieval;
}

/**
 * Wrap already-recalled fleet lessons as the engine's MemoryProvider port, so
 * the shared enhancePrompt's memory section picks them up unchanged. `remember`
 * is a no-op: fleet writes go through FleetMemory.record() directly elsewhere
 * (see fleet/orchestrator.ts), and the engine's enhance step never calls
 * `remember` — this shim exists purely to surface already-known lesson text.
 */
function memoryProviderFor(lessons: MemoryRecord[]): MemoryProvider | null {
  const text = formatLessons(lessons);
  if (!text) return null;
  return {
    recallContext: async () => text,
    remember: () => {
      /* no-op — see doc comment above */
    },
  };
}

export async function enhancePrompt(
  opts: EnhanceOptions,
): Promise<EnhanceResult> {
  const { prompt, cwd } = opts;
  const runQuery = opts.queryCodeGraph ?? queryCodeGraph;

  // Lessons first — recalled synchronously from the guaranteed fleet store, same
  // as before. Needs no code graph and must surface even if the graph can't build.
  const lessons = opts.memory?.recall(prompt, { limit: 4 }) ?? [];

  const result = await engineEnhancePrompt({
    prompt,
    codeGraph: createCodeGraphProvider((op, q, l) => runQuery(cwd, op, q, l)),
    memory: memoryProviderFor(lessons),
    maxSymbols: opts.maxSymbols,
    extraQueries: opts.extraQueries,
  });

  return {
    prompt: result.prompt,
    context: result.context,
    resolved: result.resolved,
    usedSemanticFallback: result.usedSemanticFallback,
    lessons,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    retrieval: result.retrieval,
  };
}
