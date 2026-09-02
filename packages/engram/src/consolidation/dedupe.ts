/**
 * Semantic deduplication — prevents duplicate facts from accumulating.
 *
 * Content addressing already prevents exact duplicates at the record level.
 * This module handles semantic duplicates: facts that say the same thing
 * in different words.
 */
import type { MemoryRecord, SemanticBody } from "../types";
import { tokenize, jaccardSets } from "./text-similarity";

export interface DedupeResult {
  /** Records to keep (unique facts + all non-semantic records untouched). */
  unique: MemoryRecord[];
  /** Records identified as duplicates (lower confidence kept as secondary). */
  duplicates: Array<{ keep: string; remove: string; similarity: number }>;
}

/**
 * Deduplicate semantic records by checking for near-identical facts.
 *
 * Correctness/scale properties:
 * - Non-semantic records pass through into `unique` UNTOUCHED — a caller that
 *   deletes everything not in `unique` must not lose episodic/procedural/entity
 *   records that this function never even considered.
 * - Similarity is the real token Jaccard between the two facts (recorded on each
 *   duplicate), not a hard-coded 1.0.
 * - Facts are tokenized ONCE up front, and comparisons are blocked by domain, so
 *   the O(n²) pairwise cost only pays within a domain — making tens of thousands
 *   of records feasible.
 */
export function deduplicateSemanticRecords(
  records: MemoryRecord[],
  similarityThreshold = 0.85,
): DedupeResult {
  const unique: MemoryRecord[] = [];
  const duplicates: DedupeResult["duplicates"] = [];

  // Non-semantic records are pass-through survivors.
  const semantic: MemoryRecord[] = [];
  for (const r of records) {
    if (r.kind === "semantic") semantic.push(r);
    else unique.push(r);
  }

  // Pre-tokenize each fact once; block survivors by domain so we only compare
  // within a domain.
  const tokenById = new Map<string, Set<string>>();
  for (const r of semantic) {
    tokenById.set(r.id, tokenize((r.body as SemanticBody).fact));
  }
  const survivorsByDomain = new Map<string, MemoryRecord[]>();

  for (const record of semantic) {
    const body = record.body as SemanticBody;
    const tokens = tokenById.get(record.id)!;
    const domainSurvivors = survivorsByDomain.get(body.domain) ?? [];

    let matched: MemoryRecord | null = null;
    let matchedSim = 0;
    for (const survivor of domainSurvivors) {
      const sim = jaccardSets(tokens, tokenById.get(survivor.id)!);
      if (sim >= similarityThreshold) {
        matched = survivor;
        matchedSim = sim;
        break;
      }
    }

    if (matched) {
      if (record.confidence > matched.confidence) {
        // New one is better — it replaces the survivor in its domain block.
        const idx = domainSurvivors.indexOf(matched);
        domainSurvivors[idx] = record;
        const uidx = unique.indexOf(matched);
        if (uidx >= 0) unique[uidx] = record;
        duplicates.push({
          keep: record.id,
          remove: matched.id,
          similarity: matchedSim,
        });
      } else {
        duplicates.push({
          keep: matched.id,
          remove: record.id,
          similarity: matchedSim,
        });
      }
    } else {
      unique.push(record);
      domainSurvivors.push(record);
      survivorsByDomain.set(body.domain, domainSurvivors);
    }
  }

  return { unique, duplicates };
}
