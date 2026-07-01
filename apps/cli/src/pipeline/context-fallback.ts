/**
 * Context resolution — graph first, grep fallback (Group 6, wiring Group 3's seam).
 *
 * Group 3 (the code-graph context layer) has not landed yet, so the pipeline
 * cannot depend on a live graph. This module provides the resolver the pipeline
 * needs today and the seam Group 3 plugs into: it tries the graph first (an
 * injected `graph` client), and on a miss — no client, an error, or coverage
 * below threshold — it falls back to a grep over the repo and LOGS the fallback
 * with a `[graph] … source=grep-fallback` line. "Graph before grep, and log any
 * fallback" is exactly the rule step 1 and step 2 require.
 *
 * Both the graph client and the grep search are injectable, so tests are
 * deterministic and Group 3 can swap in the real graph without touching the
 * pipeline. When Group 3 lands, wire its client in as `deps.graph`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultPipelineLogSink, type PipelineLogSink } from "./pipeline-logging.js";

const execFileAsync = promisify(execFile);

/** A file the change is expected to touch. */
export interface ImpactedFile {
  path: string;
  reason: string;
  rank?: number;
}

/** A graph query. */
export interface GraphQueryInput {
  query: string;
  focusSymbols?: string[];
  maxNodes?: number;
}

/** Structured context. `coverage` (0..1) gates the grep fallback. */
export interface GraphResult {
  impactedFiles: ImpactedFile[];
  symbols: { name: string; file: string; line?: number }[];
  edges: { from: string; to: string; type: string }[];
  coverage: number;
}

/** The context resolver the pipeline consumes. */
export interface ContextResolver {
  query(input: GraphQueryInput): Promise<GraphResult>;
  /** True if the last {@link query} was answered by the graph, not the grep fallback. */
  usedGraph(): boolean;
}

/** A grep over the repo, returning candidate impacted files. Injectable. */
export type GrepSearch = (query: string, maxResults: number) => Promise<ImpactedFile[]>;

/** A graph client (Group 3). Returns null when the graph cannot answer. */
export type GraphClient = (input: GraphQueryInput) => Promise<GraphResult | null>;

/** Options for {@link GrepFallbackResolver}. */
export interface GrepFallbackDeps {
  /** The graph client (Group 3). Omitted until Group 3 lands → always falls back. */
  graph?: GraphClient;
  /** The grep search. Defaults to a `git grep` over the repo. */
  search?: GrepSearch;
  /** Minimum graph coverage to accept the graph answer; below it, fall back. */
  coverageThreshold?: number;
  /** Max impacted files to return. */
  maxResults?: number;
  /** Log sink for the `[graph]` line. Defaults to the debug stream. */
  log?: PipelineLogSink;
}

/** Default grep: `git grep -l -i <most-significant-term>`, capped. */
const defaultSearch: GrepSearch = async (query, maxResults) => {
  const term = mostSignificantTerm(query);
  if (!term) return [];
  try {
    const { stdout } = await execFileAsync("git", ["grep", "-l", "-i", "-F", term]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, maxResults)
      .map((path) => ({ path, reason: `matches "${term}"` }));
  } catch {
    // No matches (git grep exits non-zero) or not a git repo — empty is fine.
    return [];
  }
};

/** Pick the longest word in the query as the grep term (skip tiny stopwords). */
function mostSignificantTerm(query: string): string {
  const words = query
    .split(/[^A-Za-z0-9_]+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length);
  return words[0] ?? "";
}

/**
 * The graph-first resolver with a logged grep fallback. This is the pipeline's
 * default {@link ContextResolver} until Group 3 provides a live graph client.
 */
export class GrepFallbackResolver implements ContextResolver {
  private readonly graph: GraphClient | undefined;
  private readonly search: GrepSearch;
  private readonly coverageThreshold: number;
  private readonly maxResults: number;
  private readonly log: PipelineLogSink;
  private lastUsedGraph = false;

  constructor(deps: GrepFallbackDeps = {}) {
    this.graph = deps.graph;
    this.search = deps.search ?? defaultSearch;
    this.coverageThreshold = deps.coverageThreshold ?? 0.5;
    this.maxResults = deps.maxResults ?? 50;
    this.log = deps.log ?? defaultPipelineLogSink;
  }

  usedGraph(): boolean {
    return this.lastUsedGraph;
  }

  async query(input: GraphQueryInput): Promise<GraphResult> {
    // Graph first.
    if (this.graph) {
      try {
        const result = await this.graph(input);
        if (result && result.coverage >= this.coverageThreshold) {
          this.lastUsedGraph = true;
          this.log({
            kind: "graph",
            query: input.query,
            returnedFiles: result.impactedFiles.length,
            coverage: round2(result.coverage),
            source: "graphrag",
          });
          return result;
        }
      } catch {
        // Graph errored — fall through to grep, and log the fallback below.
      }
    }

    // Grep fallback — always logged so the developer sees the graph was missed.
    this.lastUsedGraph = false;
    const impactedFiles = await this.search(input.query, input.maxNodes ?? this.maxResults);
    // Grep is a weak signal: coverage is a heuristic of how much it found, never 1.
    const coverage = impactedFiles.length === 0 ? 0 : Math.min(0.4, impactedFiles.length / 20);
    this.log({
      kind: "graph",
      query: input.query,
      returnedFiles: impactedFiles.length,
      coverage: round2(coverage),
      source: "grep-fallback",
    });
    return { impactedFiles, symbols: [], edges: [], coverage };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
