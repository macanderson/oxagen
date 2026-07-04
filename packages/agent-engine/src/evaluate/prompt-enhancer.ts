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
import type { CodeGraphProvider } from "../types";
import type { MemoryProvider } from "../ports";
import type { ContextRetrieval } from "../trace/types";
import { localize } from "../localize";
import { loadPrior, renderPrior } from "../priors";
import { filterRecall, tagRecall, type RecallItem } from "../memory/applicability";

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
  /**
   * Wall-clock budget for the whole code-graph enrichment pass. On a cold
   * store the FIRST query triggers a full tree-sitter build of the repo, which
   * on a large repo can take minutes — far more than the context is worth.
   * When the budget expires, whatever resolved so far is injected and the rest
   * is skipped; the underlying build continues in the provider's cache, so the
   * agent's own later `code_graph` tool calls still benefit. Undefined ⇒
   * unbounded (the historical behavior).
   */
  timeoutMs?: number;
  /** Repository identifier for F8 repo-prior lookup (e.g., "django/django"). */
  repo?: string;
  /** Base directory for F8 repo-prior files (e.g., ~/.oxagen/repo-priors). */
  priorsDir?: string;
}

/**
 * Race a code-graph query against the remaining budget. A timeout resolves to
 * "" (a miss) rather than rejecting — enhancement is best-effort by design.
 * The abandoned query keeps running in the provider (warming its cache); only
 * this stage stops waiting for it.
 */
async function queryWithin(
  q: Promise<string>,
  remainingMs: number,
): Promise<string> {
  if (remainingMs <= 0) return "";
  // Unbounded (or absurdly large) budget: no timer — setTimeout overflows
  // past 2^31-1 ms and would fire immediately.
  if (remainingMs > 2_147_483_647) return q.catch(() => "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), remainingMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([q.catch(() => ""), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  /** Whether any memory context was injected. */
  hasMemory: boolean;
  /** Whether F1 localization was run and produced candidates. */
  hasLocalization: boolean;
  /** Whether F8 repo prior was injected. */
  hasRepoPrior: boolean;
  /** Whether F9 memory recall filtering was applied. */
  filteredRecall: boolean;
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
 * Capitalized prose words that pattern-match the CamelCase symbol heuristic but
 * are almost never the symbol the user means. Mining them injects noise — e.g.
 * "Fix the validator" once resolved `Fix` to jquery's `fixInput` and burned
 * context tokens on irrelevant definitions. Lowercase comparison so `FIX`/`Fix`
 * both drop; real symbols like `FixDecimalInputMixin` are unaffected (full-token
 * match only).
 */
const PROSE_STOPWORDS = new Set([
  "add", "added", "allow", "allows", "also", "and", "any", "are", "because",
  "before", "but", "can", "change", "changed", "confirm", "could", "create",
  "description", "does", "example", "expected", "fix", "fixed", "for", "from",
  "have", "here", "how", "however", "instead", "into", "issue", "make", "may",
  "must", "new", "not", "note", "now", "only", "please", "problem", "remove",
  "replace", "should", "since", "some", "support", "that", "the", "then",
  "there", "therefore", "this", "update", "use", "used", "using", "when",
  "where", "which", "while", "will", "with", "would", "you",
]);

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

  // Bare file paths and identifiers in the surrounding prose. Trailing
  // sentence punctuation is not part of the identifier — "ASCIIUsernameValidator."
  // at the end of a sentence must still mine the symbol.
  for (const m of prompt.matchAll(/[A-Za-z0-9_./-]+/g)) {
    const tok = m[0].replace(/[.]+$/, "");
    if (!tok) continue;
    if (CODEY_EXT.test(tok) || (tok.includes("/") && tok.length > 3)) {
      paths.add(tok.replace(/^\.\//, ""));
    } else if (
      (/^[A-Z][A-Za-z0-9]{2,}$/.test(tok) || /^[a-z]+_[a-z0-9_]+$/.test(tok)) &&
      !PROSE_STOPWORDS.has(tok.toLowerCase())
    ) {
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

  const sections: string[] = [];
  const resolved: string[] = [];
  const symbolsQueried: string[] = [];
  const pathsQueried: string[] = [];
  let usedSemanticFallback = false;
  let hasLocalization = false;
  let hasRepoPrior = false;
  let filteredRecall = false;

  // ── F1: Deterministic localization ─────────────────────────────────────────

  // Flag semantics: localization runs UNLESS process.env.OXAGEN_LOCALIZE === "0".
  // Default on, explicit opt-out.
  const localizeFlagOff = process.env.OXAGEN_LOCALIZE === "0";

  let localizedFiles: string[] = [];
  if (!localizeFlagOff && codeGraph) {
    try {
      const locMap = await localize(prompt, codeGraph);
      if (locMap.renderedBlock.length > 0) {
        sections.push(locMap.renderedBlock);
        hasLocalization = true;
        localizedFiles = locMap.files.map((f) => f.path);
      }
    } catch {
      // localize() never throws by contract, but guard defensively.
    }
  }

  // ── F8: Repo prior injection (immediately after localization) ─────────────

  if (opts.repo && opts.priorsDir && process.env.OXAGEN_REPO_PRIORS === "1") {
    try {
      const prior = loadPrior(opts.priorsDir, opts.repo);
      if (prior) {
        const rendered = renderPrior(prior);
        if (rendered.length > 0) {
          sections.push(rendered);
          hasRepoPrior = true;
        }
      }
    } catch {
      /* prior loading is optional; graceful degradation */
    }
  }

  // ── Memory context recall ──────────────────────────────────────────────────

  let rawMemoryContext = "";
  let hasMemory = false;
  if (memory) {
    try {
      rawMemoryContext = await memory.recallContext();
      hasMemory = rawMemoryContext.trim().length > 0;
    } catch {
      /* memory recall is optional — enhancement degrades gracefully */
    }
  }

  // ── F9: Memory-recall applicability filter ─────────────────────────────────

  let memoryContext = rawMemoryContext;
  if (hasMemory && process.env.OXAGEN_RECALL_FILTER === "1") {
    try {
      // Parse raw memory into RecallItems (lines starting with "- " are new items).
      const items: RecallItem[] = [];
      let currentItem: RecallItem | null = null;
      for (const line of rawMemoryContext.split("\n")) {
        if (line.startsWith("- ")) {
          const id = `r${items.length + 1}`;
          currentItem = { id, text: line.slice(2).trim() };
          items.push(currentItem);
        } else if (line.trim() && currentItem) {
          currentItem.text += " " + line.trim();
        }
      }

      // Filter recall items: stage 1 (lexical), stage 2 (scorer=null for now).
      // Candidate files come from the localization pass above — never re-localize.
      const filtered = await filterRecall(items, { issue: prompt, candidateFiles: localizedFiles }, null);
      const taggedRecall = tagRecall(filtered);
      memoryContext = taggedRecall;
      filteredRecall = true;
    } catch {
      /* filtering is optional; fall back to raw memory */
    }
  }

  // ── Deadline for the code-graph pass (Infinity when unbounded) ────────────

  const deadline =
    opts.timeoutMs && opts.timeoutMs > 0 ? startedAt + opts.timeoutMs : Infinity;
  const remaining = (): number =>
    deadline === Infinity ? Number.MAX_SAFE_INTEGER : deadline - Date.now();

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
        if (remaining() <= 0) break;
        symbolsQueried.push(sym);
        const res = await queryWithin(codeGraph.query("search", sym, 4), remaining());
        if (isHit(res)) {
          sections.push(`Definitions of \`${sym}\`:\n${res}`);
          resolved.push(sym);
        }
      }

      // File context — symbols a referenced file defines, plus its dependents
      // (what a change to it could break). This is the impact-analysis the agent
      // would otherwise have to discover by hand.
      for (const p of [...pathSet].slice(0, max)) {
        if (remaining() <= 0) break;
        pathsQueried.push(p);
        const syms = await queryWithin(codeGraph.query("file_symbols", p, 12), remaining());
        if (isHit(syms)) {
          sections.push(`Symbols in ${p}:\n${syms}`);
          resolved.push(p);
          const deps = await queryWithin(codeGraph.query("dependents", p, 8), remaining());
          if (isHit(deps)) sections.push(deps);
        }
      }

      // Semantic fallback — literal candidates resolved little or nothing,
      // which is the common case for a conceptual prompt ("project level
      // configurations for the cli app") that names no symbol or path
      // directly. Embed the raw prompt once and cosine-rank file nodes so the
      // agent gets real context instead of falling through to blind grep.
      if (resolved.length <= SEMANTIC_FALLBACK_MAX_RESOLVED && remaining() > 0) {
        const semanticHits = await queryWithin(
          codeGraph.query("semantic_search", prompt, SEMANTIC_FALLBACK_LIMIT),
          remaining(),
        );
        if (isHit(semanticHits)) {
          sections.push(
            `Semantically relevant files (auto-retrieved via embeddings):\n${semanticHits}`,
          );
          usedSemanticFallback = true;
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
      (filteredRecall
        ? memoryContext
        : "## Recalled context (from prior sessions)\n" + memoryContext),
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
    hasMemory,
    hasLocalization,
    hasRepoPrior,
    filteredRecall,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    retrieval,
  };
}
