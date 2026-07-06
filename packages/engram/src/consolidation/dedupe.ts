/**
 * Semantic deduplication — prevents duplicate facts from accumulating.
 *
 * Content addressing already prevents exact duplicates at the record level.
 * This module handles semantic duplicates: facts that say the same thing
 * in different words.
 */
import type { MemoryRecord, SemanticBody } from "../types";

export interface DedupeResult {
  /** Records to keep (unique facts). */
  unique: MemoryRecord[];
  /** Records identified as duplicates (lower confidence kept as secondary). */
  duplicates: Array<{ keep: string; remove: string; similarity: number }>;
}

/**
 * Deduplicate semantic records by checking for near-identical facts.
 *
 * Uses a simple text overlap heuristic. In production, this would use
 * embedding cosine similarity for fuzzy matching.
 */
export function deduplicateSemanticRecords(
  records: MemoryRecord[],
  similarityThreshold = 0.85,
): DedupeResult {
  const semanticRecords = records.filter((r) => r.kind === "semantic");
  const unique: MemoryRecord[] = [];
  const duplicates: DedupeResult["duplicates"] = [];

  for (const record of semanticRecords) {
    const body = record.body as SemanticBody;
    const existingMatch = unique.find((u) => {
      const uBody = u.body as SemanticBody;
      return uBody.domain === body.domain && textSimilarity(uBody.fact, body.fact) >= similarityThreshold;
    });

    if (existingMatch) {
      // Keep the one with higher confidence
      if (record.confidence > existingMatch.confidence) {
        // New one is better — swap
        const idx = unique.indexOf(existingMatch);
        unique[idx] = record;
        duplicates.push({ keep: record.id, remove: existingMatch.id, similarity: 1.0 });
      } else {
        duplicates.push({ keep: existingMatch.id, remove: record.id, similarity: 1.0 });
      }
    } else {
      unique.push(record);
    }
  }

  return { unique, duplicates };
}

/**
 * Simple text similarity using word overlap (Jaccard coefficient).
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}
