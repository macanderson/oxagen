/**
 * Lineage tracking — full causal chain from source to derived knowledge.
 *
 * Answers: "Why does the agent believe X?" by tracing through the
 * provenance.derivedFrom chain to find the original evidence.
 *
 * Also provides trust scoring: memories derived from more reliable
 * sources (successful tools, verified facts) have higher trust.
 */
import type { MemoryRecord } from "../types";
import type { EpisodicStore } from "../store/episodic";

export interface LineageNode {
  recordId: string;
  kind: string;
  author: string;
  timestamp: number;
  confidence: number;
  depth: number; // 0 = leaf (original source), higher = more derived
}

export interface LineageChain {
  /** The record we're explaining. */
  target: LineageNode;
  /** The causal ancestors in order (most recent derivation first). */
  ancestors: LineageNode[];
  /** Trust score based on the chain quality. */
  trustScore: number;
}

/**
 * Trace the full lineage of a memory record — who created it,
 * what was it derived from, and how trustworthy is the chain.
 */
export async function traceLineage(
  recordId: string,
  store: EpisodicStore,
  maxDepth = 10,
): Promise<LineageChain | null> {
  const record = await store.getById(recordId);
  if (!record) return null;

  const target: LineageNode = {
    recordId: record.id,
    kind: record.kind,
    author: record.provenance.author,
    timestamp: Number(record.createdAt),
    confidence: record.confidence,
    depth: 0,
  };

  const ancestors: LineageNode[] = [];
  const visited = new Set<string>([recordId]);

  // Walk the derivedFrom + causality chains
  let frontier = [...record.provenance.derivedFrom, ...record.causality];
  let depth = 1;

  while (frontier.length > 0 && depth <= maxDepth) {
    const nextFrontier: string[] = [];

    for (const parentId of frontier) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);

      const parent = await store.getById(parentId);
      if (!parent) continue;

      ancestors.push({
        recordId: parent.id,
        kind: parent.kind,
        author: parent.provenance.author,
        timestamp: Number(parent.createdAt),
        confidence: parent.confidence,
        depth,
      });

      nextFrontier.push(...parent.provenance.derivedFrom, ...parent.causality);
    }

    frontier = nextFrontier;
    depth++;
  }

  const trustScore = computeTrustScore(target, ancestors);

  return { target, ancestors, trustScore };
}

/**
 * Compute trust score for a lineage chain.
 *
 * Higher trust when:
 * - Chain is short (fewer derivation steps = less information loss)
 * - Source records have high confidence
 * - Authors are reliable (system, verified sources)
 * - Records are recent (information is current)
 */
function computeTrustScore(target: LineageNode, ancestors: LineageNode[]): number {
  if (ancestors.length === 0) {
    // No derivation chain — trust is the record's own confidence
    return target.confidence;
  }

  // Factor 1: Chain length penalty (longer = less trustworthy)
  const maxDepth = Math.max(...ancestors.map((a) => a.depth));
  const depthPenalty = 1 / (1 + maxDepth * 0.15); // Gentle penalty

  // Factor 2: Average ancestor confidence
  const avgConfidence = ancestors.reduce((sum, a) => sum + a.confidence, 0) / ancestors.length;

  // Factor 3: Source reliability (system/migration authors are more reliable)
  const reliableAuthors = new Set(["system", "migration:neo4j-to-engram", "consolidation"]);
  const reliableCount = ancestors.filter((a) => reliableAuthors.has(a.author)).length;
  const reliabilityBoost = ancestors.length > 0 ? reliableCount / ancestors.length * 0.2 : 0;

  return Math.min(1, target.confidence * depthPenalty * (0.5 + avgConfidence * 0.5) + reliabilityBoost);
}

/**
 * Find all records derived from a given source record.
 * Answers: "What knowledge was built on top of this observation?"
 */
export async function findDerived(
  sourceId: string,
  store: EpisodicStore,
  namespace: { org: string; workspace: string },
  limit = 50,
): Promise<MemoryRecord[]> {
  // Query all records and filter by derivedFrom/causality containing sourceId
  const allRecords = await store.query({ namespace, limit: 500 });
  return allRecords
    .filter((r) =>
      r.provenance.derivedFrom.includes(sourceId) || r.causality.includes(sourceId),
    )
    .slice(0, limit);
}

/**
 * Get contribution stats for an agent — how many records did they
 * author, what kinds, what's their average confidence.
 */
export function agentContributionStats(
  records: MemoryRecord[],
  agentId: string,
): { totalRecords: number; byKind: Record<string, number>; avgConfidence: number } {
  const authored = records.filter((r) => r.provenance.author === agentId);
  const byKind: Record<string, number> = {};
  let totalConfidence = 0;

  for (const r of authored) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    totalConfidence += r.confidence;
  }

  return {
    totalRecords: authored.length,
    byKind,
    avgConfidence: authored.length > 0 ? totalConfidence / authored.length : 0,
  };
}
