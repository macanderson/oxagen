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

import { z } from "zod";
import { scopedSession } from "@oxagen/ontology/tenant";
import { generateObjectFor } from "@oxagen/ai";
import { upsertInferredEdges } from "../mutations/upsert-entity";
import { inferenceConfidenceThreshold } from "../filters";
import type { SemanticInferenceJob, InferenceOutput } from "../types";

const InferenceOutputSchema = z.object({
  inferredEdges: z.array(
    z.object({
      targetNaturalKey: z.string(),
      edgeType: z.enum(["INFERRED_FROM", "REFERENCES", "SIMILAR_TO", "PART_OF"]),
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
    }),
  ),
});

/**
 * Run the semantic inference pass for a committed entity node.
 * Called by the Inngest pipeline function for Stage 5.
 *
 * Steps:
 *   1. Load the node from Neo4j via scopedSession()
 *   2. Build a structured prompt: entity properties + neighbour summary
 *   3. Call generateObjectFor() with InferenceOutputSchema (Zod)
 *   4. Resolve targetNaturalKey → publicId for each inferred edge
 *   5. Write inferred edges via upsertInferredEdges()
 */
export async function inferSemanticEdges(
  job: SemanticInferenceJob,
): Promise<InferenceOutput> {
  const { nodeId, entityType, propertiesSnapshot, workspaceId, orgId } = job;

  // Step 1: Load the node from Neo4j to get its properties + naturalKey.
  const readSession = scopedSession();
  let nodeNaturalKey: string | null = null;
  let nodeDisplayName: string | null = null;
  try {
    const result = await readSession.run(
      `MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})
       RETURN n.naturalKey AS naturalKey, n.displayName AS displayName`,
      { nodeId },
    );
    const record = result.records[0];
    if (record) {
      nodeNaturalKey = record.get("naturalKey") as string | null;
      nodeDisplayName = record.get("displayName") as string | null;
    }
  } finally {
    await readSession.close();
  }

  if (!nodeNaturalKey) {
    // Node not found — nothing to infer.
    return { nodeId, inferredEdges: [], inferredNodes: [] };
  }

  // Step 2: Build a text prompt.
  const propLines = Object.entries(propertiesSnapshot)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `  ${k}: ${String(v)}`)
    .join("\n");

  const prompt = [
    `Entity type: ${entityType}`,
    nodeDisplayName ? `Display name: ${nodeDisplayName}` : null,
    `Natural key: ${nodeNaturalKey}`,
    `Properties:\n${propLines}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Step 3: Call generateObjectFor() to infer edges.
  const { object } = await generateObjectFor({
    schema: InferenceOutputSchema,
    system:
      "You are a knowledge graph analyst. Given an entity's properties, infer semantic " +
      "relationships to other entities that likely exist in the same graph. For each relationship, " +
      "provide the natural key of the target entity, the relationship type, a confidence score (0–1), " +
      "and a brief rationale. Only infer relationships you are confident about.",
    prompt,
    telemetry: {
      orgId,
      workspaceId,
      surface: "ingestion",
      // No initiating message for ingestion-time inference. Must be a UUID or
      // null — `infer:<nodeId>` would land in token_usage's UUID column and
      // credit_ledger's uuid column, dropping the row and unbilling the call.
      messageId: null,
    },
  });

  // Enforce the data-quality control: drop low-confidence inferred edges before
  // they reach the graph. The threshold is the documented
  // DeliveryConfig.semanticInference.confidenceThreshold (default 0.75), applied
  // here via the shared helper so the default stays single-sourced. Sub-threshold
  // LLM guesses would otherwise pollute the knowledge graph and surface as junk
  // relationships in context queries.
  const confidenceThreshold = inferenceConfidenceThreshold(undefined);
  const candidateEdges = object.inferredEdges.filter(
    (e) => e.confidence >= confidenceThreshold,
  );

  if (candidateEdges.length === 0) {
    return { nodeId, inferredEdges: [], inferredNodes: [] };
  }

  // Step 4: Resolve targetNaturalKey → publicId via a single batch read.
  const targetNaturalKeys = candidateEdges.map((e) => e.targetNaturalKey);
  const resolveSession = scopedSession();
  const keyToNodeId = new Map<string, string>();
  try {
    const result = await resolveSession.run(
      `UNWIND $naturalKeys AS nk
       MATCH (n:EntityNode {naturalKey: nk, orgId: $orgId})
       RETURN nk AS naturalKey, n.publicId AS nodeId`,
      { naturalKeys: targetNaturalKeys },
    );
    for (const record of result.records) {
      keyToNodeId.set(
        record.get("naturalKey") as string,
        record.get("nodeId") as string,
      );
    }
  } finally {
    await resolveSession.close();
  }

  // Step 5: Write edges for targets that exist in the graph.
  const edgesWithIds = candidateEdges.flatMap((e) => {
    const toNodeId = keyToNodeId.get(e.targetNaturalKey);
    if (!toNodeId) return [];
    return [{ fromNodeId: nodeId, toNodeId, edgeType: e.edgeType, confidence: e.confidence }];
  });

  if (edgesWithIds.length > 0) {
    await upsertInferredEdges(edgesWithIds, orgId);
  }

  return {
    nodeId,
    inferredEdges: edgesWithIds.map((e) => ({
      targetNodeId: e.toNodeId,
      edgeType: e.edgeType,
      confidence: e.confidence,
    })),
    inferredNodes: [],
  };
}
