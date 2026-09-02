/**
 * colors.ts — deterministic label → colour mapping for graph nodes.
 *
 * Pure (no React, no DOM) so it is node-testable and can be shared by the
 * canvas (per-node `fill`), the legend, and the type-filter panel. The palette
 * is a fixed set of accessible hues; a stable hash of the label picks a hue so
 * the same label always renders the same colour across renders and sessions.
 */

// A 12-hue qualitative palette chosen for contrast on both light and dark
// canvases. The ORDER is load-bearing: colorForLabel() hashes a label into an
// index, so inserting, removing, or reordering an entry recolours every node in
// every existing graph. Swap a hex value in place; never change the length.
const PALETTE = [
  "#4E6A7A", // slate
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#a16207", // bronze
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#84cc16", // lime
  "#06b6d4", // cyan
  "#A9AAB5", // silver
] as const;

/**
 * Colour used for inferred (LLM-suggested) edges to distinguish them. The brand
 * gold, which is the product's one "this is the machine's suggestion, look here"
 * colour; it is not in PALETTE, so an inferred edge never collides with a node.
 */
export const INFERRED_EDGE_COLOR = "#EFC53F";
/** Colour used for confirmed graph edges. */
export const CONFIRMED_EDGE_COLOR = "#94a3b8";

/**
 * FNV-1a style hash → palette index. Stable for a given string, well
 * distributed across the 12 buckets for typical short label strings.
 */
export function colorForLabel(label: string): string {
  let hash = 2166136261;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    // Multiply by the FNV prime, keep it in 32-bit unsigned range.
    hash = Math.imul(hash, 16777619);
  }
  const index = Math.abs(hash) % PALETTE.length;
  return PALETTE[index] as string;
}

/** Colour for an edge given whether it is inferred. */
export function colorForEdge(inferred: boolean): string {
  return inferred ? INFERRED_EDGE_COLOR : CONFIRMED_EDGE_COLOR;
}
