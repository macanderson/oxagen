/**
 * CRDT primitives — shared types and vector clock for conflict-free
 * concurrent writes across offline agents.
 */

/**
 * Vector clock: each node (agent/device) maintains its own counter.
 * Used for causal ordering and conflict detection.
 */
export interface VectorClock {
  [nodeId: string]: number;
}

/**
 * Increment a vector clock for a given node.
 */
export function tick(clock: VectorClock, nodeId: string): VectorClock {
  return { ...clock, [nodeId]: (clock[nodeId] ?? 0) + 1 };
}

/**
 * Merge two vector clocks (point-wise max).
 */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = { ...a };
  for (const [node, count] of Object.entries(b)) {
    result[node] = Math.max(result[node] ?? 0, count);
  }
  return result;
}

/**
 * Compare two vector clocks:
 * - "before": a happened-before b
 * - "after": a happened-after b
 * - "concurrent": neither dominates (conflict)
 * - "equal": identical
 */
export function compareClock(
  a: VectorClock,
  b: VectorClock,
): "before" | "after" | "concurrent" | "equal" {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aLeads = false;
  let bLeads = false;

  for (const key of allKeys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aLeads = true;
    if (bv > av) bLeads = true;
  }

  if (!aLeads && !bLeads) return "equal";
  if (aLeads && !bLeads) return "after";
  if (!aLeads && bLeads) return "before";
  return "concurrent";
}

/**
 * Generate a unique tag for OR-Set operations.
 * Combines node ID + clock value for global uniqueness.
 */
export function generateTag(nodeId: string, clock: VectorClock): string {
  const count = clock[nodeId] ?? 0;
  return `${nodeId}:${count}`;
}
