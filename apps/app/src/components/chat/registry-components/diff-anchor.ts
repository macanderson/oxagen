/**
 * Shared pure helper between `code-diff-card` and `file-tree-card` — kept in
 * its own tiny module (rather than exported from `code-diff-card.tsx`) so
 * `file-tree-card`'s lazy chunk doesn't have to pull in the entire diff-card
 * component (parser, React tree, etc.) just to compute an anchor string.
 */

/** Deterministic in-page anchor id for a file's diff section. */
export function diffAnchorId(path: string): string {
  return `diff-${encodeURIComponent(path)}`;
}
