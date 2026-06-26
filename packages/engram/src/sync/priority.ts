/**
 * Prioritized sync — ensures high-value records transfer first.
 *
 * When syncing a large batch, records are ordered by:
 * 1. Salience (high → low)
 * 2. Kind (semantic > procedural > episodic > entity > edge)
 * 3. Recency (newest first)
 */
import type { MemoryRecord } from "../types";

const KIND_PRIORITY: Record<string, number> = {
  semantic: 5,
  procedural: 4,
  episodic: 3,
  entity: 2,
  edge: 1,
};

/**
 * Sort records by sync priority (highest priority first).
 */
export function prioritizeForSync(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => {
    // Primary: salience (descending)
    if (a.salience !== b.salience) return b.salience - a.salience;
    // Secondary: kind priority (descending)
    const aPri = KIND_PRIORITY[a.kind] ?? 0;
    const bPri = KIND_PRIORITY[b.kind] ?? 0;
    if (aPri !== bPri) return bPri - aPri;
    // Tertiary: recency (most recent first)
    return Number(b.createdAt) - Number(a.createdAt);
  });
}

/**
 * Batch records into priority tiers for staged sync.
 * High-priority tier syncs first; low-priority backfills later.
 */
export function batchByPriority(
  records: MemoryRecord[],
  batchSize = 100,
): MemoryRecord[][] {
  const sorted = prioritizeForSync(records);
  const batches: MemoryRecord[][] = [];
  for (let i = 0; i < sorted.length; i += batchSize) {
    batches.push(sorted.slice(i, i + batchSize));
  }
  return batches;
}
