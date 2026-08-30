/**
 * F1 — Deterministic zero-token localization.
 *
 * Produces a ranked candidate-file map BEFORE the first LLM call, using
 * only the code graph (traceback parsing + symbol extraction + semantic
 * fallback).  Zero LLM tokens consumed anywhere in this module.
 *
 * Public API
 * ----------
 *  parseTraceback(text)          → TracebackFrame[]
 *  localize(issue, graph)        → Promise<LocalizationMap>
 *
 * Constraints (from spec F1)
 * --------------------------
 *  - No external deps, no filesystem/git access.
 *  - No `any` (TypeScript strict).
 *  - Never throws from localize() — returns empty map on any failure.
 *  - renderedBlock ≤ ~4000 chars (~1 k tokens).
 *  - Zero LLM calls.
 */

import type { CodeGraphProvider } from "../types";
import { CODEY_EXT, extractCandidates } from "../internal/extract-candidates";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single frame extracted from a Python or Node.js stack trace. */
export interface TracebackFrame {
  /** Source file path as it appears in the trace (may be relative or absolute). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Function / method name at this frame. */
  symbol: string;
}

/** Top-5 candidate locations produced by deterministic localization. */
export interface LocalizationMap {
  files: Array<{
    path: string;
    symbols: string[];
    score: number;
    reason: string;
  }>;
  /** Likely test files / directories for the top candidates. */
  testHints: string[];
  /** True when at least one traceback frame was extracted from the issue text. */
  tracebackParsed: boolean;
  /**
   * Markdown block injected verbatim into the ENHANCE context.
   * Stays ≤ ~1 000 tokens (hard-capped at 4 000 chars with truncation).
   */
  renderedBlock: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Maximum characters for renderedBlock (~1 k tokens). */
const RENDERED_BLOCK_CAP = 4_000;

/** Maximum files to return. */
const TOP_N = 5;

/** Minimum distinct files before the semantic fallback is triggered. */
const SEMANTIC_FALLBACK_THRESHOLD = 3;

/**
 * Patterns that identify stdlib / vendor / site-packages frames to filter out.
 * Checked against the raw file path from the trace.
 */
const VENDOR_PATTERNS: RegExp[] = [
  /\/site-packages\//,
  /\/dist-packages\//,
  /\/lib\/python\d/,
  /\/Lib\/python\d/i,
  /(?:^|\/)node_modules\//,
  /\/vendor\//,
  /^<frozen /,
  /^<string>/,
  /\/lib\/node_modules\//,
  // CPython internal paths
  /\/cpython\//,
  /\/pypy\//,
];

/**
 * Score weights from the spec.
 *   score = 3·traceback_hit + 2·symbol_hit + 1·semantic_sim + 0.5·dependents_centrality
 */
const W_TRACEBACK = 3;
const W_SYMBOL = 2;
const W_SEMANTIC = 1;
const W_DEPENDENTS = 0.5;

// ── parseTraceback ────────────────────────────────────────────────────────────

/**
 * Parse Python (CPython) and Node.js stack traces from arbitrary text.
 *
 * Python format:
 *   File "path/to/file.py", line N, in symbol
 *
 * Node.js format:
 *   at symbol (file:line:col)
 *   at symbol (file:line)
 *   at file:line:col   (anonymous frame)
 *
 * Returns frames ordered innermost-first (closest to the error origin),
 * with stdlib/vendor frames filtered out.
 */
export function parseTraceback(text: string): TracebackFrame[] {
  const frames: TracebackFrame[] = [];

  // ── Python CPython format ──────────────────────────────────────────────────
  // Matches:  File "path/to/file.py", line 42, in some_function
  // Also handles chained exceptions and ExceptionGroup (same grammar, different
  // outer context — the frame lines themselves are identical).
  const pyRe = /File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = pyRe.exec(text)) !== null) {
    const file = m[1] ?? "";
    const line = parseInt(m[2] ?? "0", 10);
    const symbol = m[3] ?? "<unknown>";
    if (!isVendorFrame(file)) {
      frames.push({ file, line, symbol });
    }
  }

  // ── Node.js format ────────────────────────────────────────────────────────
  // Matches:  at SymbolName (path/to/file.js:42:7)
  //           at path/to/file.js:42:7   (anonymous)
  const nodeRe = /at\s+(?:([^\s(]+)\s+\()?([^():]+\.[a-z]+):(\d+)(?::\d+)?\)?/g;
  while ((m = nodeRe.exec(text)) !== null) {
    const symbol = m[1] ?? "<anonymous>";
    const file = m[2] ?? "";
    const line = parseInt(m[3] ?? "0", 10);
    if (file && !isVendorFrame(file)) {
      frames.push({ file, line, symbol });
    }
  }

  // Reverse so that innermost frames (last in the trace) come first.
  // Python tracebacks print outermost first; Node.js does too.
  return frames.reverse();
}

/** Returns true when a file path belongs to stdlib / vendor and should be skipped. */
function isVendorFrame(file: string): boolean {
  return VENDOR_PATTERNS.some((re) => re.test(file));
}

// ── isHit ─────────────────────────────────────────────────────────────────────

/** True when a code-graph result string represents a real hit (not a "No …" miss). */
function isHit(result: string): boolean {
  return (
    result.length > 0 &&
    !/^No (symbols?|file) /.test(result) &&
    !/^Nothing imports/.test(result) &&
    !/^No results/.test(result)
  );
}

// ── parseGraphPaths ───────────────────────────────────────────────────────────

/**
 * Extract file paths from a raw code-graph result string.
 * The graph returns lines like:
 *   function foo — packages/foo/src/bar.ts:12  export function foo(...) { ... }
 *   packages/foo/src/bar.ts: (file_symbols header)
 *   packages/foo/src/bar.ts  (semantic_search / dependents / imports)
 */
function parseGraphPaths(raw: string): string[] {
  const paths = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Pattern: "... — path/to/file.ts:N  ..."  (search / file_symbols)
    const dashMatch = / — ([^\s:]+\.[a-z]+):\d+/.exec(trimmed);
    if (dashMatch) {
      paths.add(dashMatch[1]!);
      continue;
    }
    // Pattern: "path/to/file.ts:" at line start (file_symbols header)
    const headerMatch = /^([^\s:]+\.[a-z]+):$/.exec(trimmed);
    if (headerMatch) {
      paths.add(headerMatch[1]!);
      continue;
    }
    // Pattern: bare path (dependents / imports / semantic_search lines)
    const bareMatch = /^([^\s:]+\.[a-z]+)(?:\s|$)/.exec(trimmed);
    if (bareMatch && CODEY_EXT.test(bareMatch[1]!)) {
      paths.add(bareMatch[1]!);
    }
  }
  return [...paths];
}

// ── parseGraphSymbols ─────────────────────────────────────────────────────────

/**
 * Extract symbol names from a raw code-graph result string (search / file_symbols).
 * Lines look like:
 *   function foo — packages/foo/src/bar.ts:12  export function foo(...)
 *   interface Bar — packages/foo/src/bar.ts:5  export interface Bar { ... }
 */
function parseGraphSymbols(raw: string, forPath: string): string[] {
  const syms: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes(forPath)) continue;
    // "kind name — path:line  ..."
    const m = /^(?:\w+\s+)?(\w[\w.]*)\s+—/.exec(line.trim());
    if (m) syms.push(m[1]!);
  }
  return syms;
}

// ── nearestTestDir ────────────────────────────────────────────────────────────

/**
 * Derive likely test directories from a set of source file paths.
 * Heuristic: look for a `tests/`, `test/`, or `__tests__/` sibling under the
 * same package root (first two path segments).
 */
function nearestTestDirs(paths: string[]): string[] {
  const hints = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    // e.g. "packages/foo/src/bar.ts" → root = "packages/foo"
    if (parts.length >= 2) {
      const root = parts.slice(0, 2).join("/");
      hints.add(`${root}/tests`);
      hints.add(`${root}/test`);
      hints.add(`${root}/src/__tests__`);
    }
    // Also check adjacent test file: "foo/bar.ts" → "foo/bar.test.ts"
    const testFile = p.replace(/\.(ts|tsx|js|jsx|py)$/, ".test.$1");
    if (testFile !== p) hints.add(testFile);
  }
  return [...hints].slice(0, 6);
}

// ── renderLocalizationMap ─────────────────────────────────────────────────────

/**
 * Render a LocalizationMap to a markdown block ≤ RENDERED_BLOCK_CAP chars.
 */
function renderLocalizationMap(
  files: LocalizationMap["files"],
  testHints: string[],
): string {
  if (files.length === 0) return "";

  const lines: string[] = ["## Candidate locations (deterministic)", ""];
  for (const f of files) {
    const syms = f.symbols.length > 0 ? f.symbols.slice(0, 5).join(", ") : "—";
    lines.push(`- **${f.path}** — \`${syms}\` — ${f.reason}`);
  }

  if (testHints.length > 0) {
    lines.push("");
    lines.push(`**Likely test dirs:** ${testHints.slice(0, 4).join(", ")}`);
  }

  lines.push("");
  lines.push(
    "_Candidate locations were computed from the code graph. Verify with one read before trusting; do not re-derive them._",
  );

  let block = lines.join("\n");
  if (block.length > RENDERED_BLOCK_CAP) {
    block = block.slice(0, RENDERED_BLOCK_CAP - 3) + "...";
  }
  return block;
}

// ── localize ──────────────────────────────────────────────────────────────────

/** Accumulator used while building the scored file map. */
interface FileScore {
  path: string;
  symbols: Set<string>;
  tracebackScore: number;
  symbolScore: number;
  semanticScore: number;
  dependentsScore: number;
  reasons: Set<string>;
}

function totalScore(fs: FileScore): number {
  return (
    W_TRACEBACK * fs.tracebackScore +
    W_SYMBOL * fs.symbolScore +
    W_SEMANTIC * fs.semanticScore +
    W_DEPENDENTS * fs.dependentsScore
  );
}

/** Empty map returned on failure / absent graph. */
const EMPTY_MAP: LocalizationMap = {
  files: [],
  testHints: [],
  tracebackParsed: false,
  renderedBlock: "",
};

/**
 * Deterministic zero-token localization.
 *
 * Given an issue string (bug report / task description), queries the code
 * graph to rank the top-5 most likely source files.  Never throws; returns
 * an empty map on any failure or when the graph is absent.
 */
export interface LocalizeOptions {
  /**
   * Run the embedding semantic-search fallback when literal (traceback +
   * symbol) resolution yields too few files. Default true. ENHANCE passes
   * false: the prompt-enhancer owns the semantic-fallback decision with its
   * own "resolved enough" gate, so the localizer must not run a second,
   * differently-thresholded semantic query that would surface files the
   * enhancer deliberately withheld.
   */
  semanticFallback?: boolean;
  /**
   * Wall-clock budget (ms) for the whole localization pass. On a cold store
   * the first graph query can trigger a full repo index build — far longer
   * than the map is worth. When the budget expires, whatever scored so far is
   * ranked and returned, and every remaining query is skipped without touching
   * the provider (the abandoned in-flight query keeps warming the provider's
   * cache). Undefined / non-positive / larger than the max 32-bit timer ⇒
   * unbounded. ENHANCE passes its remaining `enhanceTimeoutMs` budget here so
   * localization can never extend the stage budget.
   */
  timeoutMs?: number;
}

/** setTimeout overflows past 2^31−1 ms and would fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export async function localize(
  issue: string,
  graph: CodeGraphProvider | null | undefined,
  opts: LocalizeOptions = {},
): Promise<LocalizationMap> {
  if (!graph) return EMPTY_MAP;

  const deadline =
    opts.timeoutMs && opts.timeoutMs > 0 && opts.timeoutMs <= MAX_TIMER_MS
      ? Date.now() + opts.timeoutMs
      : Infinity;

  // One gate per pass, owned here so its timer is released on EVERY exit —
  // including the failure path, where `_localize` would otherwise never reach
  // its own dispose call.
  const gate = createDeadlineGate(deadline);
  try {
    return await _localize(issue, graph, opts.semanticFallback ?? true, gate);
  } catch {
    return EMPTY_MAP;
  } finally {
    gate.dispose();
  }
}

async function _localize(
  issue: string,
  graph: CodeGraphProvider,
  semanticFallback: boolean,
  // The pass's shared wall-clock budget. Every safeQuery gates on this single
  // timer's event, so short-circuiting after the deadline is deterministic
  // regardless of monotonic/wall clock skew under load. Owned (and disposed) by
  // the caller.
  gate: DeadlineGate,
): Promise<LocalizationMap> {
  const scoreMap = new Map<string, FileScore>();

  function touch(path: string): FileScore {
    let entry = scoreMap.get(path);
    if (!entry) {
      entry = {
        path,
        symbols: new Set(),
        tracebackScore: 0,
        symbolScore: 0,
        semanticScore: 0,
        dependentsScore: 0,
        reasons: new Set(),
      };
      scoreMap.set(path, entry);
    }
    return entry;
  }

  // ── Step A: Traceback path ─────────────────────────────────────────────────

  const frames = parseTraceback(issue);
  const tracebackParsed = frames.length > 0;

  for (const frame of frames) {
    // Try to resolve via graph search (symbol name)
    const searchResult = await safeQuery(
      graph,
      "search",
      frame.symbol,
      4,
      gate,
    );
    if (isHit(searchResult)) {
      for (const p of parseGraphPaths(searchResult)) {
        const e = touch(p);
        e.tracebackScore += 1;
        e.reasons.add(`traceback: ${frame.symbol} at line ${frame.line}`);
        for (const s of parseGraphSymbols(searchResult, p)) e.symbols.add(s);
      }
    }

    // Also try file_symbols on the frame's file path (resolves relative paths)
    const fileResult = await safeQuery(
      graph,
      "file_symbols",
      frame.file,
      8,
      gate,
    );
    if (isHit(fileResult)) {
      // The file path itself or the paths returned
      const resolved = parseGraphPaths(fileResult);
      const targets = resolved.length > 0 ? resolved : [frame.file];
      for (const p of targets) {
        const e = touch(p);
        e.tracebackScore += 1;
        e.reasons.add(`traceback: ${frame.file}:${frame.line}`);
        for (const s of parseGraphSymbols(fileResult, p)) e.symbols.add(s);
      }
    }

    // One-hop expansion: dependents + imports of each traceback-hit file
    const tracebackFiles = [...scoreMap.keys()].filter(
      (p) => (scoreMap.get(p)?.tracebackScore ?? 0) > 0,
    );
    for (const p of tracebackFiles) {
      const depsResult = await safeQuery(graph, "dependents", p, 5, gate);
      if (isHit(depsResult)) {
        for (const dp of parseGraphPaths(depsResult)) {
          const e = touch(dp);
          e.dependentsScore += 1;
          e.reasons.add(`dependent of traceback file ${p}`);
        }
      }
      const importsResult = await safeQuery(graph, "imports", p, 5, gate);
      if (isHit(importsResult)) {
        for (const ip of parseGraphPaths(importsResult)) {
          const e = touch(ip);
          e.dependentsScore += 0.5;
          e.reasons.add(`imported by traceback file ${p}`);
        }
      }
    }
  }

  // ── Step B: Symbol path ────────────────────────────────────────────────────

  const { symbols, paths } = extractCandidates(issue);

  for (const sym of symbols.slice(0, 8)) {
    const res = await safeQuery(graph, "search", sym, 4, gate);
    if (isHit(res)) {
      for (const p of parseGraphPaths(res)) {
        const e = touch(p);
        e.symbolScore += 1;
        e.reasons.add(`symbol match: ${sym}`);
        for (const s of parseGraphSymbols(res, p)) e.symbols.add(s);
      }
    }
  }

  for (const path of paths.slice(0, 6)) {
    const res = await safeQuery(graph, "file_symbols", path, 8, gate);
    if (isHit(res)) {
      const resolved = parseGraphPaths(res);
      const targets = resolved.length > 0 ? resolved : [path];
      for (const p of targets) {
        const e = touch(p);
        e.symbolScore += 1;
        e.reasons.add(`path match: ${path}`);
        for (const s of parseGraphSymbols(res, p)) e.symbols.add(s);
      }
    }
  }

  // ── Step C: Semantic fallback ──────────────────────────────────────────────

  const distinctFiles = scoreMap.size;
  if (semanticFallback && distinctFiles < SEMANTIC_FALLBACK_THRESHOLD) {
    const semResult = await safeQuery(graph, "semantic_search", issue, 5, gate);
    if (isHit(semResult)) {
      for (const p of parseGraphPaths(semResult)) {
        const e = touch(p);
        e.semanticScore += 1;
        e.reasons.add("semantic similarity");
      }
    }
  }

  // ── Step D: Score fusion + top-5 ──────────────────────────────────────────

  const ranked = [...scoreMap.values()]
    .map((fs) => ({
      path: fs.path,
      symbols: [...fs.symbols].slice(0, 8),
      score: totalScore(fs),
      reason: [...fs.reasons].slice(0, 2).join("; "),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  const testHints = nearestTestDirs(ranked.map((f) => f.path));
  const renderedBlock = renderLocalizationMap(ranked, testHints);

  return {
    files: ranked,
    testHints,
    tracebackParsed,
    renderedBlock,
  };
}

// ── deadline gate ───────────────────────────────────────────────────────────

/**
 * A single, shared wall-clock budget for one localization pass.
 *
 * One timer, one flag. When the budget expires the timer callback flips
 * `expired` and resolves `timeout`; every subsequent query reads that flag
 * instead of re-deriving the remaining budget from `Date.now()`. That matters
 * because `setTimeout` fires against libuv's monotonic loop clock (snapshotted
 * at the start of the event-loop tick), while `Date.now()` reads the wall
 * clock — so a per-query timer can resolve a hair *before* `Date.now()` reaches
 * the deadline, and a naive `remaining = deadline - Date.now()` recheck would
 * then see a sliver of budget and let one extra query through. Gating on the
 * timer's own event makes short-circuiting deterministic under load.
 */
interface DeadlineGate {
  /** True once the shared budget timer has fired (or the budget was already spent). */
  readonly expired: boolean;
  /**
   * Resolves to "" when the budget expires; `null` when the budget is
   * unbounded (no timer, queries await their provider directly).
   */
  readonly timeout: Promise<string> | null;
  /** Release the timer. Idempotent; a no-op when the gate is unbounded. */
  dispose(): void;
}

/** Build the shared deadline gate for a pass from an absolute wall-clock deadline. */
function createDeadlineGate(deadline: number): DeadlineGate {
  // Unbounded budget: no timer, never expires.
  if (deadline === Infinity) {
    return { expired: false, timeout: null, dispose() {} };
  }
  const remaining = deadline - Date.now();
  // Budget already spent before the first query — skip everything.
  if (remaining <= 0) {
    return { expired: true, timeout: Promise.resolve(""), dispose() {} };
  }
  // Over the max 32-bit timer ⇒ treat as unbounded (a shorter timer would
  // overflow and fire immediately).
  if (remaining > MAX_TIMER_MS) {
    return { expired: false, timeout: null, dispose() {} };
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve("");
    }, remaining);
    timer.unref?.();
  });
  return {
    get expired() {
      return expired;
    },
    timeout,
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

// ── safeQuery ─────────────────────────────────────────────────────────────────

/**
 * Wrap a graph query so that any thrown error returns "" (a miss).
 * localize() must never throw, and individual query failures must not abort
 * the whole localization pass.
 *
 * Deadline-aware: once the pass's shared budget is spent (`gate.expired`), the
 * query is skipped without touching the provider. An in-flight query is raced
 * against the shared budget (the abandoned promise keeps running in the
 * provider, warming its cache — only this pass stops waiting). Mirrors the
 * ENHANCE stage's `queryWithin` so localization can never extend the stage
 * budget.
 */
async function safeQuery(
  graph: CodeGraphProvider,
  operation:
    | "search"
    | "file_symbols"
    | "dependents"
    | "imports"
    | "semantic_search",
  query: string,
  limit: number | undefined,
  gate: DeadlineGate,
): Promise<string> {
  if (gate.expired) return "";
  try {
    const q = graph.query(operation, query, limit).catch(() => "");
    // Unbounded budget: no timer, await the provider directly.
    if (gate.timeout === null) return await q;
    return await Promise.race([q, gate.timeout]);
  } catch {
    return "";
  }
}
