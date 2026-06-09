/**
 * Stage 5 — Semantic inference.
 *
 * An async LLM worker that receives the committed entity node + its immediate
 * graph neighbourhood (configurable hop depth) and infers:
 *   - Semantic edges to other nodes (IMPLEMENTS, PART_OF, REFERENCES, etc.)
 *   - New inferred nodes (Feature, Topic, Risk, Decision) not directly present
 *     in the source data
 *
 * Runs after embedding (Stage 4) so it can use vector similarity to find
 * candidate target nodes for inferred edges without a full graph scan.
 *
 * Output is written via upsertInferredEdges(). All inferred edges carry
 *   { inferred: true, confidence, model, inferredAt }
 * so they can be filtered or weighted separately in context queries.
 */

import type { SemanticInferenceJob, InferenceOutput } from "../types";

/**
 * Run the semantic inference pass for a committed entity node.
 * Called by the Inngest pipeline function for Stage 5.
 *
 * TODO(ingestion): implement
 *   1. Load the node + contextHops-depth subgraph from Neo4j
 *   2. Build a structured prompt: entity properties + neighbour summary
 *   3. Call generateObject() with InferenceOutputSchema (Zod)
 *   4. Write inferred edges via upsertInferredEdges()
 *   5. Queue new inferred nodes through resolveEntity() (Stage 3) so they
 *      get their own dedup pass and embeddings
 */
export async function inferSemanticEdges(
  _job: SemanticInferenceJob,
): Promise<InferenceOutput> {
  // TODO(ingestion): implement semantic inference worker
  throw new Error("inferSemanticEdges: not yet implemented");
}
