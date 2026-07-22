/**
 * ANN over-sampling for tenant-filtered vector search.
 *
 * `db.index.vector.queryNodes(index, k, vector)` returns the GLOBAL top-`k`
 * nodes by cosine similarity — the index knows nothing about tenancy, labels,
 * or status. When a query then filters by `orgId`/`workspaceId` (or any other
 * predicate) in the WHERE clause *after* the index call, matches for the active
 * tenant can be crowded out of the top-`k` by higher-scoring nodes belonging to
 * OTHER tenants. Recall then silently degrades as global graph volume grows:
 * the caller asks for `limit` results, the index hands back `limit` global
 * hits, and the post-filter can shrink that to a handful — or zero.
 *
 * The fix is to over-fetch from the index (`k = limit × factor`) so enough
 * per-tenant candidates survive the post-filter, then trim back to `limit`
 * after filtering. This helper computes the over-sampled `k` with a hard cap so
 * a large requested `limit` can't explode into a multi-thousand-row index scan.
 *
 * Always trim the filtered rows back to the original `limit` (via Cypher
 * `LIMIT $limit` or an in-memory `slice(0, limit)`) — this helper only sizes
 * the index fetch, it does not bound the returned result set.
 */
export const DEFAULT_OVERSAMPLE_FACTOR = 3;

/**
 * Over-sampling factor for an AGENT-SCOPED vector search (Agent RBAC Phase 3,
 * spec §4 Phase 3 risk note: "label filters interact with vector-index entry
 * points — filter post-ANN with oversampling"). A GraphScope label allow-list
 * is a second post-ANN predicate ON TOP of the tenancy filter, so attrition
 * compounds: the global top-k must survive tenant filtering AND scope-label
 * filtering. Double the default factor (2 × DEFAULT_OVERSAMPLE_FACTOR) buys
 * headroom for that second filter; DEFAULT_OVERSAMPLE_CAP still bounds the
 * index fetch, so a scoped query can never scan more than an unscoped one's
 * ceiling.
 */
export const SCOPE_OVERSAMPLE_FACTOR = 6;

/**
 * Hard ceiling on the over-sampled fetch size. Keeps a large requested `limit`
 * from turning into a runaway index scan while still leaving generous headroom
 * for post-filter attrition.
 */
export const DEFAULT_OVERSAMPLE_CAP = 500;

/**
 * Compute the over-sampled index fetch size for a tenant-filtered ANN query.
 *
 * Returns `min(ceil(limit) × factor, max(limit, cap))` — never fewer than the
 * requested `limit` (so a small cap can't under-fetch below what the caller
 * asked for) and never more than `cap`. Non-positive or non-finite `limit`
 * yields `0` (an empty request stays empty).
 */
export function oversampledLimit(
  limit: number,
  factor: number = DEFAULT_OVERSAMPLE_FACTOR,
  cap: number = DEFAULT_OVERSAMPLE_CAP,
): number {
  const base = Math.trunc(limit);
  if (!Number.isFinite(base) || base <= 0) return 0;

  const f = Number.isFinite(factor) && factor >= 1 ? Math.trunc(factor) : 1;
  const oversampled = base * f;

  // Never let the cap pull the fetch below the requested limit.
  const ceiling = Math.max(base, Math.trunc(cap));
  return Math.min(oversampled, ceiling);
}
