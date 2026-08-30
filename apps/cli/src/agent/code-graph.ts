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
 *
 * `semantic_search` answers *conceptual* questions the other operations can't —
 * "where are the project-level configs" names no symbol or path, so substring
 * search returns nothing. It embeds the query and cosine-ranks file nodes
 * against vectors from the Group 3 semantic index (`context/embedding.ts` +
 * `context/semantic-index.ts`), reusing that infra rather than standing up a
 * second embedding path: same gateway model, same DuckDB columns, same
 * lazy/incremental embed-on-first-use. When no gateway key is configured it
 * degrades to a plain miss string, same shape as every other operation's
 * "not found" case.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildCodeGraph,
  buildAndPersistCodeGraph,
} from "../daemon/code-graph/builder.js";
import {
  searchSymbols,
  dependents,
  imports as importsOf,
} from "../daemon/code-graph/query.js";
import {
  createCodeGraphStore,
  defaultCodeGraphDbPath,
} from "../daemon/code-graph/store.js";
import type { CodeGraphStore } from "../daemon/code-graph/store.js";
import type { CodeGraph, CodeNode } from "../daemon/code-graph/types.js";
import {
  resolveEmbeddingClient,
  type EmbeddingClient,
} from "./context/embedding.js";
import {
  ensureFileEmbeddings,
  rankFilesBySimilarity,
} from "./context/semantic-index.js";
import type { CodeGraphProvider } from "@oxagen/agent-engine";

/**
 * Derived from — not duplicated from — CodeGraphProvider.query's own operation
 * parameter. @oxagen/agent-engine's types.ts is the single source of truth for
 * this union; adding a new operation there flows here automatically instead of
 * needing a hand-kept copy to stay in sync.
 */
export type CodeGraphOperation = Parameters<CodeGraphProvider["query"]>[0];

/**
 * Test-only override seam for the `semantic_search` operation; every other
 * operation ignores it. Production callers never pass this: `client` defaults
 * to {@link resolveEmbeddingClient} and `store` to a fresh, self-managed
 * {@link CodeGraphStore} connection so newly-computed vectors are persisted
 * (opened and closed around the single call, same pattern as
 * {@link loadOrBuildCodeGraph}). Tests inject a deterministic fake client (and
 * `store: null` to skip DuckDB I/O) to exercise the ranking path without the
 * gateway.
 */
export interface SemanticSearchDeps {
  client?: EmbeddingClient | null;
  store?: CodeGraphStore | null;
}

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
 * Prime the per-cwd code-graph cache in the background so the first turn's
 * enhance stage hits a WARM graph instead of paying a cold tree-sitter build
 * (135s+ on a large repo) on the critical path. Fire-and-forget: it kicks off
 * (and memoizes) the same build `getCodeGraph` would, and swallows any error —
 * a failed warm-up just means the first real query builds it, exactly as before.
 * Call once at REPL/session startup.
 */
export function warmCodeGraph(cwd: string): void {
  void getCodeGraph(cwd).catch(() => {});
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
    if (!suffixMatch && node.path.endsWith(`/${q}`)) suffixMatch = node;
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
 * `query` is a symbol name for `search`, a natural-language concept for
 * `semantic_search`, or a file path for the rest.
 */
export async function queryCodeGraph(
  cwd: string,
  operation: CodeGraphOperation,
  query: string,
  limit = 25,
  deps: SemanticSearchDeps = {},
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
      if (imps.length === 0)
        return `${file.path} has no resolved local imports.`;
      const paths = imps
        .map((n) => n.path)
        .sort()
        .slice(0, limit);
      return `${file.path} imports (${imps.length}):\n${paths.join("\n")}`;
    }
    case "semantic_search": {
      const client =
        deps.client !== undefined
          ? deps.client
          : await resolveEmbeddingClient(cwd);
      if (!client) {
        return `No file matching semantic query "${query}" (embeddings unavailable — no gateway key).`;
      }

      // Own our store connection unless a test injected one: open, embed, close —
      // same open/work/close shape as loadOrBuildCodeGraph. A store that fails to
      // open (e.g. the daemon holds the write lock) degrades to an unpersisted,
      // in-memory-only ranking rather than failing the whole query.
      let store: CodeGraphStore | null = null;
      let ownsStore = false;
      if (deps.store !== undefined) {
        store = deps.store;
      } else {
        try {
          store = createCodeGraphStore({
            duckdbPath: defaultCodeGraphDbPath(),
          });
          await store.whenReady();
          ownsStore = true;
        } catch {
          store = null;
        }
      }

      try {
        const { vectors } = await ensureFileEmbeddings({
          graph,
          root: cwd,
          client,
          store,
        });
        if (vectors.size === 0)
          return `No file matching semantic query "${query}".`;
        const queryVector = await client.embed(query);
        const ranked = rankFilesBySimilarity(
          graph,
          queryVector,
          vectors,
          limit,
        );
        if (ranked.length === 0)
          return `No file matching semantic query "${query}".`;
        return ranked
          .map((r) => `${r.path} (${r.score.toFixed(2)})`)
          .join("\n");
      } catch {
        // Network/gateway failure mid-embed — degrade like a miss, never throw.
        return `No file matching semantic query "${query}" (embeddings unavailable).`;
      } finally {
        if (ownsStore && store) {
          try {
            await store.close();
          } catch {
            /* ignore */
          }
        }
      }
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
