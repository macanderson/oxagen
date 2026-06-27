/**
 * Neo4j label safety.
 *
 * Neo4j labels CANNOT be parameterized in Cypher (`MATCH (n:$label)` is illegal),
 * so any customer- or model-supplied domain label that becomes a real node label
 * must be interpolated into the query string. That makes it an injection surface.
 * Every such interpolation MUST pass through `assertValidLabel` first, which
 * enforces a strict identifier grammar — no spaces, quotes, backticks, colons, or
 * Cypher metacharacters can survive.
 *
 * Two-layer model (see memory: graph-node-anchor-and-is-system-model):
 *  - `ANCHOR_LABEL` (:GraphNode) is the fixed structural label on every tenant
 *    node; it backs the publicId/scope/vector indexes and is never dynamic.
 *  - The domain label (:Submarine, :Execution, …) is the node's real type. Customer
 *    types are validated here; the Schema Registry is the upstream allow-list that
 *    decides WHICH types may exist (see graph.ingest-vocabulary), while this module
 *    guarantees whatever string reaches a query is structurally safe.
 */

/** The neutral anchor label carried by every tenant graph node. */
export const ANCHOR_LABEL = "GraphNode" as const;

// A Neo4j label we are willing to interpolate: starts with a letter, then letters,
// digits or underscores, max 99 chars total. Deliberately stricter than Neo4j's
// own (backtick-quoted) label rules so the value never needs escaping.
const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,98}$/;

/** True when `label` is safe to interpolate directly into a Cypher label position. */
export function isValidLabel(label: string): boolean {
  return LABEL_PATTERN.test(label);
}

/**
 * Return `label` unchanged if it is a structurally safe Neo4j label, else throw.
 * Use at every boundary where a non-constant label is written into a query string.
 */
export function assertValidLabel(label: string): string {
  if (!isValidLabel(label)) {
    throw new Error(
      `Invalid Neo4j label ${JSON.stringify(label)}: must match ${LABEL_PATTERN} ` +
        `(letter, then letters/digits/underscore, ≤99 chars). Labels cannot be ` +
        `parameterized, so only validated labels may be interpolated.`,
    );
  }
  return label;
}

/**
 * Coerce an arbitrary free-text type ("Nuclear-powered submarine", "pull_request")
 * into a single valid Neo4j label, or return null if nothing usable remains.
 *
 * Rules: collapse any run of non-alphanumeric characters to a single underscore,
 * trim leading/trailing underscores, prefix `N_` when the result would start with a
 * digit, and cap at 99 chars. The result always satisfies `isValidLabel`.
 *
 *   "Nuclear-powered submarine" → "Nuclear_powered_submarine"
 *   "pull_request"              → "pull_request"
 *   "3D model"                  → "N_3D_model"
 *   "!!!"                       → null
 */
export function sanitizeLabel(raw: string): string | null {
  const collapsed = raw
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (collapsed.length === 0) return null;
  const prefixed = /^[A-Za-z]/.test(collapsed) ? collapsed : `N_${collapsed}`;
  const capped = prefixed.slice(0, 99);
  // The slice could re-introduce a trailing underscore at the 99-char boundary.
  const cleaned = capped.replace(/_+$/g, "");
  return isValidLabel(cleaned) ? cleaned : null;
}
