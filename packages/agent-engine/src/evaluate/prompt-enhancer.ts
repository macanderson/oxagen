/**
 * Automatic prompt enhancement.
 *
 * Before a prompt is handed to the agent (or split into a plan), this enriches it
 * with the context the engine already has about the repository: the code graph (a
 * symbol + import index — where things are defined, what imports them) and
 * the recalled memory context. The user types "fix the login bug"; the agent
 * receives that plus the exact files and symbols involved and the gotchas it
 * learned last time. That is what makes the agent both faster (less blind
 * grepping) and cheaper (fewer exploratory tool calls before it acts).
 *
 * Unlike the CLI version, this module uses the engine's injected ports
 * ({@link CodeGraphProvider} and {@link MemoryProvider}) rather than calling
 * `queryCodeGraph` directly or using `FleetMemory`. This makes it suitable for
 * both the CLI (local symbol index) and the platform (remote Neo4j graph,
 * `agent.memory.*` context).
 */
import type { CodeGraphProvider } from "../types.js";
import type { MemoryProvider } from "../ports.js";
import type { ContextRetrieval } from "../trace/types.js";

export interface EnhanceOptions {
  prompt: string;
  /**
   * Code graph provider for symbol/path lookups. When omitted, code-graph
   * enrichment is skipped — the prompt is still returned with any memory context.
   */
  codeGraph?: CodeGraphProvider | null;
  /**
   * Memory provider for recalled lessons. When omitted, memory enrichment is
   * skipped. Calls `recallContext()` to get a pre-formatted context string.
   */
  memory?: MemoryProvider | null;
  /** Max distinct symbols/paths to look up (default 6). */
  maxSymbols?: number;
  /**
   * Extra retrieval hints (e.g. the evaluator's `contextQueries`): symbol names,
   * file paths, or topics. They are mined for candidates and looked up in the code
   * graph, but never appended to the visible prompt text — only what they resolve
   * to is injected.
   */
  extraQueries?: string[];
}

export interface EnhanceResult {
  /** The original prompt with the retrieved context appended. */
  prompt: string;
  /** The retrieved context block alone (empty if nothing was found). */
  context: string;
  /** Symbol/path tokens that resolved to something in the code graph. */
  resolved: string[];
  /** Whether any memory context was injected. */
  hasMemory: boolean;
  /** Epoch ms context-gathering started. */
  startedAt: number;
  /** Epoch ms context-gathering finished. */
  finishedAt: number;
  /** Wall-clock ms spent gathering + injecting context. */
  durationMs: number;
  /** Which candidates were mined and which resolved (for verbose telemetry). */
  retrieval: ContextRetrieval;
}

const CODEY_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sql|py|go|rs|sh|yml|yaml|toml)$/;

/**
 * Pull likely code references out of a natural-language prompt: backticked spans,
 * file paths, and identifier-shaped tokens (CamelCase / snake_case / dotted).
 */
export function extractCandidates(prompt: string): { symbols: string[]; paths: string[] } {
  const symbols = new Set<string>();
  const paths = new Set<string>();

  // Backticked spans are the strongest signal — the user is quoting code.
  for (const m of prompt.matchAll(/`([^`]+)`/g)) {
    const inner = (m[1] ?? "").trim();
    if (!inner) continue;
    if (inner.includes("/") || CODEY_EXT.test(inner)) paths.add(inner);
    else if (/^[\w.$]+$/.test(inner)) symbols.add(inner);
  }

  // Bare file paths and identifiers in the surrounding prose.
  for (const m of prompt.matchAll(/[A-Za-z0-9_./-]+/g)) {
    const tok = m[0];
    if (CODEY_EXT.test(tok) || (tok.includes("/") && tok.length > 3)) {
      paths.add(tok.replace(/^\.\//, ""));
    } else if (/^[A-Z][A-Za-z0-9]{2,}$/.test(tok) || /^[a-z]+_[a-z0-9_]+$/.test(tok)) {
      // CamelCase (Foo, GraphNode) or snake_case (build_tools) — likely symbols.
      symbols.add(tok);
    }
  }

  return { symbols: [...symbols], paths: [...paths] };
}

/** True when a code-graph result string represents a real hit (not a "No …" miss). */
function isHit(result: string): boolean {
  return result.length > 0 && !/^No (symbols?|file) /.test(result) && !/^Nothing imports/.test(result);
}

export async function enhancePrompt(opts: EnhanceOptions): Promise<EnhanceResult> {
  const { prompt, codeGraph, memory } = opts;
  const max = opts.maxSymbols ?? 6;
  const startedAt = Date.now();

  // Memory context — recalled from the provider as a pre-formatted string.
  // This is retrieved first: it needs no code graph and must surface even if it fails.
  let memoryContext = "";
  let hasMemory = false;
  if (memory) {
    try {
      memoryContext = await memory.recallContext();
      hasMemory = memoryContext.trim().length > 0;
    } catch {
      /* memory recall is optional — enhancement degrades gracefully */
    }
  }

  const sections: string[] = [];
  const resolved: string[] = [];
  const symbolsQueried: string[] = [];
  const pathsQueried: string[] = [];

  if (codeGraph) {
    try {
      const { symbols, paths } = extractCandidates(prompt);
      // Evaluator-supplied hints are authoritative — the model explicitly named them
      // — so classify each directly (like a backticked span) rather than mining it
      // from prose. They sharpen retrieval without polluting the visible prompt text.
      const symSet = new Set(symbols);
      const pathSet = new Set(paths);
      for (const q of opts.extraQueries ?? []) {
        const t = q.trim();
        if (!t) continue;
        if (t.includes("/") || CODEY_EXT.test(t)) pathSet.add(t.replace(/^\.\//, ""));
        else if (/^[\w.$]+$/.test(t)) symSet.add(t);
        // Multi-word topics that aren't identifiers are skipped — they won't resolve.
      }

      // Symbol definitions — "where is X defined".
      for (const sym of [...symSet].slice(0, max)) {
        symbolsQueried.push(sym);
        const res = await codeGraph.query("search", sym, 4);
        if (isHit(res)) {
          sections.push(`Definitions of \`${sym}\`:\n${res}`);
          resolved.push(sym);
        }
      }

      // File context — symbols a referenced file defines, plus its dependents
      // (what a change to it could break). This is the impact-analysis the agent
      // would otherwise have to discover by hand.
      for (const p of [...pathSet].slice(0, max)) {
        pathsQueried.push(p);
        const syms = await codeGraph.query("file_symbols", p, 12);
        if (isHit(syms)) {
          sections.push(`Symbols in ${p}:\n${syms}`);
          resolved.push(p);
          const deps = await codeGraph.query("dependents", p, 8);
          if (isHit(deps)) sections.push(deps);
        }
      }
    } catch {
      /* code graph unavailable — enhancement is optional */
    }
  }

  const parts: string[] = [];
  if (sections.length > 0) {
    parts.push(
      "## Relevant code context (auto-retrieved from the code graph)\n" +
        "Use this to skip exploration and go straight to the right files.\n\n" +
        sections.join("\n\n"),
    );
  }
  if (hasMemory && memoryContext) {
    parts.push(
      "## Recalled context (from prior sessions)\n" + memoryContext,
    );
  }

  const context = parts.join("\n\n");
  const enhanced = context ? `${prompt}\n\n${context}` : prompt;

  const finishedAt = Date.now();
  const resolvedSet = new Set(resolved);
  const retrieval: ContextRetrieval = {
    symbolsQueried,
    pathsQueried,
    resolved,
    unresolved: [...symbolsQueried, ...pathsQueried].filter((c) => !resolvedSet.has(c)),
  };

  return {
    prompt: enhanced,
    context,
    resolved,
    hasMemory,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    retrieval,
  };
}
