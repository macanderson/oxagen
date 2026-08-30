/**
 * ContextResolver — the graph-before-grep entry point.
 *
 * A caller injects this as its context collaborator and calls `query()` before
 * reaching for a text scan. The resolver:
 *
 *   1. queries the code graph (semantic + structural) for a bounded subgraph,
 *   2. returns it as structured JSON when coverage clears the threshold, and
 *   3. otherwise logs WHY the graph was insufficient and falls back to a grep
 *      scan (when `graph.fallbackToGrep` is on).
 *
 * Every fallback is logged with its reason (`[graph] fallback=grep reason="…"`),
 * and every graph hit is logged too (`[graph] query="…" returned_files=N
 * coverage=… source=graphrag`), so the debug stream shows exactly which path
 * served each request. `usedGraph()` reports whether the last query was answered
 * by the graph or fell back.
 *
 * NOTE: nothing in the shipped agent loop constructs this yet — the `graph_query`
 * tool it backs is not registered in any tool set. Treat it as staged, not live.
 */
import { getCodeGraph } from "../code-graph.js";
import { debugLog, isDebugEnabled } from "../../lib/debug-log.js";
import type { CodeGraph } from "../../daemon/code-graph/types.js";
import type { CodeGraphStore } from "../../daemon/code-graph/store.js";
import { readGraphConfig, MIN_COVERAGE, type GraphConfig } from "./config.js";
import { resolveEmbeddingClient, type EmbeddingClient } from "./embedding.js";
import {
  runGraphQuery,
  type GraphContextResult,
  type GraphQueryOptions,
} from "./graph-query.js";
import { grepFallback } from "./grep-fallback.js";

/** The orchestrator's structured context input (mirrors orchestrator/types.ts). */
export interface GraphQueryInput {
  query: string;
  focusSymbols?: string[];
  maxNodes?: number;
  /** Optional traversal controls (superset of the contract). */
  hops?: number;
  flow?: GraphQueryOptions["flow"];
}

/** The structured graph result — assignable to the orchestrator's GraphResult. */
export interface GraphResult {
  impactedFiles: { path: string; reason: string; rank?: number }[];
  symbols: { name: string; kind?: string; file: string; line?: number }[];
  edges: { from: string; to: string; type: string }[];
  coverage: number;
}

/** A structured log event for the two graph outcomes. Injectable for tests. */
export type GraphLogEvent =
  | {
      kind: "hit";
      query: string;
      returnedFiles: number;
      coverage: number;
      source: string;
    }
  | { kind: "fallback"; to: "grep" | "none"; reason: string; query: string };

export type GraphLogFn = (event: GraphLogEvent) => void;

/** Default logger: structured JSONL entry + a human `[graph] …` line under debug. */
function defaultGraphLog(event: GraphLogEvent): void {
  if (event.kind === "hit") {
    void debugLog("code-graph", "query", {
      query: event.query,
      returnedFiles: event.returnedFiles,
      coverage: event.coverage,
      source: event.source,
    });
    if (isDebugEnabled()) {
      process.stderr.write(
        `[graph] query="${event.query}" returned_files=${event.returnedFiles} ` +
          `coverage=${event.coverage.toFixed(2)} source=graphrag\n`,
      );
    }
  } else {
    void debugLog("code-graph", "fallback", {
      to: event.to,
      reason: event.reason,
      query: event.query,
    });
    if (isDebugEnabled()) {
      process.stderr.write(
        `[graph] fallback=${event.to} reason="${event.reason}"\n`,
      );
    }
  }
}

/** Injectable dependencies for {@link GraphContextResolver}. */
export interface GraphContextResolverDeps {
  /** Working directory the graph and fallback scan are rooted at. */
  cwd?: string;
  /** Effective graph config. Defaults to {@link readGraphConfig}. */
  config?: GraphConfig;
  /** Load the code graph. Defaults to the daemon-backed {@link getCodeGraph}. */
  loadGraph?: (cwd: string) => Promise<CodeGraph>;
  /** Resolve the embedding client, or null. Defaults to {@link resolveEmbeddingClient}. */
  resolveClient?: (cwd: string) => Promise<EmbeddingClient | null>;
  /** DuckDB store for persisting lazily-computed vectors (optional). */
  store?: CodeGraphStore | null;
  /** The grep fallback. Defaults to {@link grepFallback}. */
  grep?: (cwd: string, query: string) => Promise<GraphResult["impactedFiles"]>;
  /** Structured logger. Defaults to {@link defaultGraphLog}. */
  log?: GraphLogFn;
}

export class GraphContextResolver {
  private readonly cwd: string;
  private readonly config: GraphConfig;
  private readonly loadGraph: (cwd: string) => Promise<CodeGraph>;
  private readonly resolveClient: (
    cwd: string,
  ) => Promise<EmbeddingClient | null>;
  private readonly store: CodeGraphStore | null;
  private readonly grep: (
    cwd: string,
    query: string,
  ) => Promise<GraphResult["impactedFiles"]>;
  private readonly log: GraphLogFn;
  private lastUsedGraph = false;

  constructor(deps: GraphContextResolverDeps = {}) {
    this.cwd = deps.cwd ?? process.cwd();
    this.config = deps.config ?? readGraphConfig();
    this.loadGraph = deps.loadGraph ?? getCodeGraph;
    this.resolveClient =
      deps.resolveClient ?? ((c) => resolveEmbeddingClient(c));
    this.store = deps.store ?? null;
    this.grep = deps.grep ?? ((c, q) => grepFallback(c, q));
    this.log = deps.log ?? defaultGraphLog;
  }

  /** True when the most recent {@link query} was answered by the graph. */
  usedGraph(): boolean {
    return this.lastUsedGraph;
  }

  async query(input: GraphQueryInput): Promise<GraphResult> {
    // 1. Disabled → go straight to the fallback (logged).
    if (!this.config.enabled) {
      return this.fallback(input, "graph.enabled is false");
    }

    // 2. Load the graph. An empty/failed graph cannot answer.
    let graph: CodeGraph;
    try {
      graph = await this.loadGraph(this.cwd);
    } catch (err) {
      return this.fallback(
        input,
        `graph load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (graph.nodes.size === 0) {
      return this.fallback(input, "code graph is empty (not indexed)");
    }

    // 3. Run the query.
    const result: GraphContextResult = await runGraphQuery({
      input,
      graph,
      root: this.cwd,
      client: await this.resolveClient(this.cwd),
      store: this.store,
      config: this.config,
    });

    // 4. Coverage gate: a confident, non-empty result wins; otherwise fall back.
    if (result.coverage >= MIN_COVERAGE && result.impactedFiles.length > 0) {
      this.lastUsedGraph = true;
      this.log({
        kind: "hit",
        query: input.query,
        returnedFiles: result.impactedFiles.length,
        coverage: result.coverage,
        source: result.source,
      });
      return toGraphResult(result);
    }

    const reason =
      result.impactedFiles.length === 0
        ? "graph returned no impacted files for the query"
        : `graph coverage ${result.coverage.toFixed(2)} below threshold ${MIN_COVERAGE}`;
    return this.fallback(input, reason, result);
  }

  /**
   * Log the reason the graph was insufficient and, when enabled, grep. When
   * `fallbackToGrep` is off we return the (weak) graph result, or an empty one.
   */
  private async fallback(
    input: GraphQueryInput,
    reason: string,
    weak?: GraphContextResult,
  ): Promise<GraphResult> {
    this.lastUsedGraph = false;
    if (!this.config.fallbackToGrep) {
      this.log({ kind: "fallback", to: "none", reason, query: input.query });
      return weak ? toGraphResult(weak) : emptyResult();
    }
    this.log({ kind: "fallback", to: "grep", reason, query: input.query });
    const impactedFiles = await this.grep(this.cwd, input.query);
    return { impactedFiles, symbols: [], edges: [], coverage: 0 };
  }
}

function toGraphResult(r: GraphContextResult): GraphResult {
  return {
    impactedFiles: r.impactedFiles,
    symbols: r.symbols,
    edges: r.edges,
    coverage: r.coverage,
  };
}

function emptyResult(): GraphResult {
  return { impactedFiles: [], symbols: [], edges: [], coverage: 0 };
}

/** Convenience factory used by the orchestrator wiring and the tool. */
export function createContextResolver(
  deps: GraphContextResolverDeps = {},
): GraphContextResolver {
  return new GraphContextResolver(deps);
}
