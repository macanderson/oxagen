/**
 * Consolidation: Episodic → Semantic distillation.
 *
 * Clusters episodic events by topic similarity, then extracts durable
 * semantic facts from each cluster. This is the core "sleep" function
 * that turns a log of events into structured knowledge.
 */
import type { MemoryRecord, SemanticBody } from "../types";

export interface DistillationConfig {
  /** Minimum cluster size to consider for distillation. Default: 3. */
  minClusterSize: number;
  /** Cosine similarity threshold for clustering. Default: 0.7. */
  clusterThreshold: number;
  /** Initial confidence for newly distilled facts. Default: 0.6. */
  initialConfidence: number;
}

export const DEFAULT_DISTILLATION_CONFIG: DistillationConfig = {
  minClusterSize: 3,
  clusterThreshold: 0.7,
  initialConfidence: 0.6,
};

export interface DistillationResult {
  /** Newly extracted semantic facts. */
  newFacts: Array<{ fact: SemanticBody; confidence: number; derivedFrom: string[] }>;
  /** Existing facts whose confidence should be boosted. */
  boostedFacts: Array<{ recordId: string; newConfidence: number }>;
  /** Events that were processed (to mark as consolidated). */
  processedEventIds: string[];
}

/**
 * Cluster episodic events by body similarity.
 * Simple approach: group by event type + high overlap in payload keys.
 */
export function clusterEvents(
  events: MemoryRecord[],
  _config: DistillationConfig,
): MemoryRecord[][] {
  const groups = new Map<string, MemoryRecord[]>();

  for (const event of events) {
    const body = event.body as Record<string, unknown>;
    // Group key: kind + event type + domain (if semantic-adjacent)
    const eventType = (body.event as string) ?? event.kind;
    const domain = (body.domain as string) ?? (body.tool as string) ?? "general";
    const key = `${event.kind}:${eventType}:${domain}`;

    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }

  // Only return clusters meeting minimum size
  return [...groups.values()].filter((g) => g.length >= _config.minClusterSize);
}

/**
 * Extract a semantic fact from a cluster of related episodic events.
 *
 * For now, uses a heuristic approach (extract common patterns from payloads).
 * In production, this would call a small LLM to summarize the cluster.
 */
export function extractFactFromCluster(
  cluster: MemoryRecord[],
): SemanticBody | null {
  if (cluster.length === 0) return null;

  // Extract common patterns
  const bodies = cluster.map((r) => r.body as Record<string, unknown>);
  const firstBody = bodies[0]!;

  // For episodic events: the common event type + outcome pattern becomes the fact
  const eventType = (firstBody.event as string) ?? "";
  const outcomes = bodies
    .map((b) => b.outcome as string | undefined)
    .filter(Boolean);
  const successCount = outcomes.filter((o) => o === "success").length;
  const failureCount = outcomes.filter((o) => o === "failure").length;

  // Generate a fact about this pattern
  const totalOutcomes = successCount + failureCount;
  let fact: string;
  if (totalOutcomes > 0) {
    const successRate = Math.round((successCount / totalOutcomes) * 100);
    fact = `Action "${eventType}" has a ${successRate}% success rate across ${cluster.length} observations`;
  } else {
    fact = `Action "${eventType}" has been observed ${cluster.length} times`;
  }

  const domain = (firstBody.domain as string) ??
    (firstBody.tool as string) ?? "general";

  return { fact, domain };
}

/**
 * Run distillation on a batch of unconsolidated episodic events.
 */
export function distill(
  events: MemoryRecord[],
  existingFacts: MemoryRecord[],
  config: DistillationConfig = DEFAULT_DISTILLATION_CONFIG,
): DistillationResult {
  const clusters = clusterEvents(events, config);
  const newFacts: DistillationResult["newFacts"] = [];
  const boostedFacts: DistillationResult["boostedFacts"] = [];

  for (const cluster of clusters) {
    const fact = extractFactFromCluster(cluster);
    if (!fact) continue;

    // Check if this fact already exists
    const existing = findExistingFact(fact, existingFacts);
    if (existing) {
      // Boost confidence: seeing the same pattern again reinforces it
      const newConf = Math.min(1.0, existing.confidence + 0.05);
      boostedFacts.push({ recordId: existing.id, newConfidence: newConf });
    } else {
      newFacts.push({
        fact,
        confidence: config.initialConfidence,
        derivedFrom: cluster.map((e) => e.id),
      });
    }
  }

  return {
    newFacts,
    boostedFacts,
    processedEventIds: events.map((e) => e.id),
  };
}

/**
 * Find an existing semantic fact that matches the new one.
 * Matches on domain + similar fact text.
 */
function findExistingFact(
  newFact: SemanticBody,
  existing: MemoryRecord[],
): MemoryRecord | null {
  for (const record of existing) {
    if (record.kind !== "semantic") continue;
    const body = record.body as Record<string, unknown>;
    if (body.domain === newFact.domain && typeof body.fact === "string") {
      // Simple similarity: both mention the same action
      if (body.fact.includes(newFact.fact.split('"')[1] ?? "")) {
        return record;
      }
    }
  }
  return null;
}
