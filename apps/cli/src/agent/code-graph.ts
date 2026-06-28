/**
 * Code-graph retrieval for the agent loop.
 *
 * Wraps the daemon's code-graph builder/query API with a per-cwd, in-process
 * cache so a coding turn can ask *structural* questions about the repository —
 * "where is X defined?", "what imports this file?" — instead of blind grep.
 *
 * The graph is loaded from the persistent DuckDB store on first use, re-parsing
 * only files whose content changed (incremental), and reused for the rest of the
 * process. If the store can't be opened — e.g. the daemon holds the write lock —
 * it falls back to a pure in-memory build, so the capability works with or
 * without the daemon and `oxagen` can dogfood itself from a cold start.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildCodeGraph, buildAndPersistCodeGraph } from "../daemon/code-graph/builder.js";
import {
  searchSymbols,
  dependents,
  imports as importsOf,
} from "../daemon/code-graph/query.js";
import { createCodeGraphStore, defaultCodeGraphDbPath } from "../daemon/code-graph/store.js";
import type { CodeGraphStore } from "../daemon/code-graph/store.js";
import type { CodeGraph, CodeNode } from "../daemon/code-graph/types.js";

export type CodeGraphOperation =
  | "search"
  | "file_symbols"
  | "dependents"
  | "imports";

const cache = new Map<string, Promise<CodeGraph>>();

/** Build (or reuse) the code graph rooted at `cwd`. One load per cwd per process. */
export function getCodeGraph(cwd: string): Promise<CodeGraph> {
  let graph = cache.get(cwd);
  if (!graph) {
    graph = loadOrBuildCodeGraph(cwd);
    cache.set(cwd, graph);
  }
  return graph;
}

/**
 * Load the code graph from the persistent store (incrementally refreshing it
 * first), falling back to an in-memory build when the store is unavailable.
 */
async function loadOrBuildCodeGraph(cwd: string): Promise<CodeGraph> {
  let store: CodeGraphStore | null = null;
  try {
    const dbPath = defaultCodeGraphDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    store = createCodeGraphStore({ duckdbPath: dbPath });
    await store.whenReady();
    await buildAndPersistCodeGraph(cwd, store);
    return await store.loadGraph(cwd);
  } catch {
    return buildCodeGraph(cwd); // store locked/unavailable — in-memory fallback
  } finally {
    if (store) {
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Drop cached graphs (used by tests; also lets a long-lived REPL force a rebuild). */
export function clearCodeGraphCache(): void {
  cache.clear();
}

/** Resolve a user-supplied path to a file node: exact rel-path first, then suffix match. */
function fileNodeFor(graph: CodeGraph, query: string): CodeNode | null {
  const q = query.replace(/^\.\//, "");
  let suffixMatch: CodeNode | null = null;
  for (const node of graph.nodes.values()) {
    if (node.kind !== "file") continue;
    if (node.path === q) return node;
    if (!suffixMatch && (node.path === q || node.path.endsWith(`/${q}`))) {
      suffixMatch = node;
    }
  }
  return suffixMatch;
}

/** Symbols a file directly contains (functions/classes/types extracted from it). */
function symbolsInFile(graph: CodeGraph, fileNode: CodeNode): CodeNode[] {
  return graph.edges
    .filter((e) => e.source === fileNode.id && e.type === "contains")
    .map((e) => graph.nodes.get(e.target))
    .filter((n): n is CodeNode => n !== undefined);
}

function formatSymbol(node: CodeNode): string {
  const sig = node.signature ? `  ${node.signature}` : "";
  return `${node.kind} ${node.name} — ${node.path}:${node.range.start}${sig}`;
}

/**
 * Run one code-graph operation and return a compact, model-readable string.
 * `query` is a symbol name for `search`, or a file path for the others.
 */
export async function queryCodeGraph(
  cwd: string,
  operation: CodeGraphOperation,
  query: string,
  limit = 25,
): Promise<string> {
  const graph = await getCodeGraph(cwd);

  switch (operation) {
    case "search": {
      const hits = searchSymbols(graph, query, limit);
      if (hits.length === 0) return `No symbols matching "${query}".`;
      return hits.map(formatSymbol).join("\n");
    }
    case "file_symbols": {
      const file = fileNodeFor(graph, query);
      if (!file) return `No file matching "${query}".`;
      const syms = symbolsInFile(graph, file).slice(0, limit);
      if (syms.length === 0) {
        return `${file.path}: (no top-level symbols extracted)`;
      }
      return `${file.path}:\n${syms.map(formatSymbol).join("\n")}`;
    }
    case "dependents": {
      const file = fileNodeFor(graph, query);
      if (!file) return `No file matching "${query}".`;
      const deps = dependents(graph, file.id);
      if (deps.length === 0) return `Nothing imports ${file.path}.`;
      const paths = deps
        .map((n) => n.path)
        .sort()
        .slice(0, limit);
      return `Files importing ${file.path} (${deps.length}):\n${paths.join("\n")}`;
    }
    case "imports": {
      const file = fileNodeFor(graph, query);
      if (!file) return `No file matching "${query}".`;
      const imps = importsOf(graph, file.id);
      if (imps.length === 0) return `${file.path} has no resolved local imports.`;
      const paths = imps
        .map((n) => n.path)
        .sort()
        .slice(0, limit);
      return `${file.path} imports (${imps.length}):\n${paths.join("\n")}`;
    }
  }
}

/** Index summary for a one-line "indexed N files / M symbols" message. */
export async function codeGraphStats(
  cwd: string,
): Promise<{ files: number; symbols: number; edges: number }> {
  const graph = await getCodeGraph(cwd);
  let files = 0;
  let symbols = 0;
  for (const node of graph.nodes.values()) {
    if (node.kind === "file") files++;
    else symbols++;
  }
  return { files, symbols, edges: graph.edges.length };
}
