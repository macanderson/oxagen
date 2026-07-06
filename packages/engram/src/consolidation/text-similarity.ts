/**
 * Shared text similarity for consolidation (distill dedup, semantic dedupe).
 *
 * One tokenizer + Jaccard implementation so distill and dedupe score matches
 * identically, and so callers can pre-tokenize once instead of re-splitting on
 * every pairwise comparison (the O(n²) dedupe path needs that).
 */

/** Tokenize text into a lowercased set of word tokens (length >= 2). */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

/** Jaccard similarity between two pre-tokenized sets (0..1). */
export function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set for speed.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Convenience: Jaccard similarity between two raw strings. */
export function jaccard(a: string, b: string): number {
  return jaccardSets(tokenize(a), tokenize(b));
}
