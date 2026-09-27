// What a decided memory PR leaves behind (ADR-206, decision 7).
//
// The curator settles each open memory PR before it plans the next one. A
// proposed record that is still at its path at the merge commit merged. A
// record the person deleted before merging, and every record of a PR closed
// unmerged, did not merge, so its statements are rejected. A person decided
// on every retirement either way. Every memory the PR cited is purged.
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
  const purgeMemoryIds = new Set<string>();
  for (const record of pr.records) {
    for (const id of record.memoryIds) purgeMemoryIds.add(id);
    if (record.action === "retire") {
      reviewedLineages.add(record.lineage);
      continue;
    }
    if (merged && presentAtMerge.has(record.path)) {
      mergedLineages.add(record.lineage);
      continue;
    }
    for (const hash of record.statementHashes) rejectedHashes.add(hash);
  }
  return {
    prId: pr.id,
    status: merged ? "merged" : "closed",
    settledAt: merged ? (state.mergedAt ?? now) : now,
    mergedLineages: [...mergedLineages],
    reviewedLineages: [...reviewedLineages],
    rejectedHashes: [...rejectedHashes],
    purgeMemoryIds: [...purgeMemoryIds],
  };
}
