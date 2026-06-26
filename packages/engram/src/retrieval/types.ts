/**
 * Shared types for the retrieval engine layer.
 */
import type { MemoryRecord, Namespace } from "../types";

/**
 * A candidate record scored by a retrieval engine.
 */
export interface RetrievalCandidate {
  record: MemoryRecord;
  /** Normalized score 0.0–1.0 from the engine. */
  score: number;
  /** Which engine produced this candidate. */
  source: "vector" | "lexical" | "graph" | "temporal" | "pinned";
  /** Estimated token cost if included verbatim in the context window. */
  tokenCost: number;
}

/**
 * Query parameters passed to each retrieval engine.
 */
export interface RetrievalQuery {
  namespace: Namespace;
  /** Natural language description of the current task/goal. */
  taskDescription: string;
  /** Currently active entity IDs (files, symbols, services). */
  workingSet: string[];
  /** Last N episodic event record IDs for recency context. */
  recentEventIds: string[];
  /** Max candidates to return per engine. */
  limit: number;
}

/**
 * The TaskFrame captures everything needed to compile a context window.
 */
export interface TaskFrame {
  namespace: Namespace;
  taskDescription: string;
  workingSet: string[];
  recentEventIds: string[];
  /** Model ID determines tokenizer and budget calculation. */
  modelId: string;
  /** Hash of the previous compile() window for cache-stability computation. */
  previousWindowHash?: string;
  sessionId?: string;
  agentId?: string;
}

/**
 * Contract for a retrieval engine. Each engine implements this interface.
 */
export interface RetrievalEngine {
  name: string;
  retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]>;
}
