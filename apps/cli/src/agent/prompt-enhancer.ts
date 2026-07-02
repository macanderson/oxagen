/**
 * Automatic prompt enhancement.
 *
 * Before a prompt is handed to the agent (or split into a plan), this enriches it
 * with the context the CLI already has about the repository: the code graph (a
 * local symbol + import index — where things are defined, what imports them) and
 * the fleet's recorded lessons. The user types "fix the login bug"; the agent
 * receives that plus the exact files and symbols involved and the gotchas it
 * learned last time. That is what makes the agent both faster (less blind
 * grepping) and cheaper (fewer exploratory tool calls before it acts).
 *
 * The code graph is the knowledge graph the CLI carries offline; when the
 * platform knowledge graph is reachable it can augment this, but enhancement
 * never depends on the network and degrades to a no-op if the graph can't build.
 */
import { queryCodeGraph } from "./code-graph.js";
import { formatLessons, type FleetMemory } from "./fleet/memory.js";
import type { MemoryRecord } from "./fleet/types.js";
import type { ContextRetrieval } from "./trace.js";

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

const CODEY_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sql|py|go|rs|sh|yml|yaml|toml)$/;

/**
 * Literal candidates resolved at or below this count → the prompt is probably
 * conceptual (names no exact symbol/path), so fall back to one embedding
 * search over the raw prompt. "Few", not only "zero": a prompt that names one
 * thing precisely can still be mostly about a subsystem it never names.
 */
const SEMANTIC_FALLBACK_MAX_RESOLVED = 1;
/** Bounded — a few files to orient the agent, not a second exploration budget. */
const SEMANTIC_FALLBACK_LIMIT = 5;

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
  const { prompt, cwd } = opts;
  const max = opts.maxSymbols ?? 6;
  const runQuery = opts.queryCodeGraph ?? queryCodeGraph;
  const startedAt = Date.now();

  // Lessons first — they need no code graph and must surface even if it fails.
  const lessons = opts.memory?.recall(prompt, { limit: 4 }) ?? [];

  const sections: string[] = [];
  const resolved: string[] = [];
  const symbolsQueried: string[] = [];
  const pathsQueried: string[] = [];
  let usedSemanticFallback = false;

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
      const res = await runQuery(cwd, "search", sym, 4);
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
      const syms = await runQuery(cwd, "file_symbols", p, 12);
      if (isHit(syms)) {
        sections.push(`Symbols in ${p}:\n${syms}`);
        resolved.push(p);
        const deps = await runQuery(cwd, "dependents", p, 8);
        if (isHit(deps)) sections.push(deps);
      }
    }

    // Semantic fallback — literal candidates resolved little or nothing, which
    // is the common case for a conceptual prompt ("project level configurations
    // for the cli app") that names no symbol or path directly. Embed the raw
    // prompt once and cosine-rank file nodes so the agent gets real context
    // instead of falling through to blind grep.
    if (resolved.length <= SEMANTIC_FALLBACK_MAX_RESOLVED) {
      const semanticHits = await runQuery(cwd, "semantic_search", prompt, SEMANTIC_FALLBACK_LIMIT);
      if (isHit(semanticHits)) {
        sections.push(
          `Semantically relevant files (auto-retrieved via embeddings):\n${semanticHits}`,
        );
        usedSemanticFallback = true;
      }
    }
  } catch {
    /* code graph unavailable (e.g. unreadable cwd) — enhancement is optional */
  }

  const parts: string[] = [];
  if (sections.length > 0) {
    parts.push(
      "## Relevant code context (auto-retrieved from the code graph)\n" +
        "Use this to skip exploration and go straight to the right files.\n\n" +
        sections.join("\n\n"),
    );
  }
  if (lessons.length > 0) {
    parts.push(
      "## Lessons from past work on this repo (recalled memory)\n" + formatLessons(lessons),
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
    usedSemanticFallback,
    lessons,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    retrieval,
  };
}
