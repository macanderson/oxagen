// What a decided memory PR leaves behind (ADR-206 decision 7, as ADR-245
// amends it).
//
// The curator settles each open memory PR before it plans the next one. A
// proposed record that is still at its path at the merge commit merged, and
// its memories become promoted and link to it. A record the person deleted
// before merging, and every record of a PR closed unmerged, did not merge, so
// its statements are rejected and its memories wait again. A person decided
// on every retirement either way. No memory is deleted: each keeps its row
// and its uses.
import type { OpenMemoryPr, PrSettlement, PrState } from "./types";

/**
 * Settle one memory PR, or return null while it is still open.
 * `presentAtMerge` holds the paths that exist at the merge commit. A closed PR
 * has no merge commit, so the set is not read.
 */
export function settleMemoryPr(
  pr: OpenMemoryPr,
  state: PrState,
  presentAtMerge: ReadonlySet<string>,
  now: Date,
): PrSettlement | null {
  if (state.open) return null;
  const merged = state.merged;
  const mergedLineages = new Set<string>();
  const reviewedLineages = new Set<string>();
  const rejectedHashes = new Set<string>();
  const promoted: PrSettlement["promoted"] = [];
  const returnedMemoryIds = new Set<string>();
  for (const record of pr.records) {
    if (record.action === "retire") {
      reviewedLineages.add(record.lineage);
      continue;
    }
    if (merged && presentAtMerge.has(record.path)) {
      mergedLineages.add(record.lineage);
      promoted.push({
        lineage: record.lineage,
        memoryIds: [...new Set(record.memoryIds)],
      });
      continue;
    }
    for (const hash of record.statementHashes) rejectedHashes.add(hash);
    for (const id of record.memoryIds) returnedMemoryIds.add(id);
  }
  return {
    prId: pr.id,
    status: merged ? "merged" : "closed",
    settledAt: merged ? (state.mergedAt ?? now) : now,
    mergedLineages: [...mergedLineages],
    reviewedLineages: [...reviewedLineages],
    rejectedHashes: [...rejectedHashes],
    promoted,
    returnedMemoryIds: [...returnedMemoryIds],
  };
}
