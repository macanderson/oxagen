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
}

export interface EnhanceResult {
  /** The original prompt with the retrieved context appended. */
  prompt: string;
  /** The retrieved context block alone (empty if nothing was found). */
  context: string;
  /** Symbol/path tokens that resolved to something in the code graph. */
  resolved: string[];
  /** Lessons recalled from fleet memory. */
  lessons: MemoryRecord[];
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
  const { prompt, cwd } = opts;
  const max = opts.maxSymbols ?? 6;

  // Lessons first — they need no code graph and must surface even if it fails.
  const lessons = opts.memory?.recall(prompt, { limit: 4 }) ?? [];

  const sections: string[] = [];
  const resolved: string[] = [];

  try {
    // Mine candidates from the prompt prose, then fold in any evaluator-supplied
    // hints as direct candidates (a bare symbol name or file path to look up).
    // Hints sharpen retrieval without polluting the visible prompt text.
    const { symbols, paths } = extractCandidates(prompt);
    const symSet = new Set(symbols);
    const pathSet = new Set(paths);
    for (const hint of opts.extraQueries ?? []) {
      const t = hint.trim();
      if (!t) continue;
      if (t.includes("/") || CODEY_EXT.test(t)) pathSet.add(t.replace(/^\.\//, ""));
      else symSet.add(t);
    }

    // Symbol definitions — "where is X defined".
    for (const sym of [...symSet].slice(0, max)) {
      const res = await queryCodeGraph(cwd, "search", sym, 4);
      if (isHit(res)) {
        sections.push(`Definitions of \`${sym}\`:\n${res}`);
        resolved.push(sym);
      }
    }

    // File context — symbols a referenced file defines, plus its dependents
    // (what a change to it could break). This is the impact-analysis the agent
    // would otherwise have to discover by hand.
    for (const p of [...pathSet].slice(0, max)) {
      const syms = await queryCodeGraph(cwd, "file_symbols", p, 12);
      if (isHit(syms)) {
        sections.push(`Symbols in ${p}:\n${syms}`);
        resolved.push(p);
        const deps = await queryCodeGraph(cwd, "dependents", p, 8);
        if (isHit(deps)) sections.push(deps);
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

  return { prompt: enhanced, context, resolved, lessons };
}
