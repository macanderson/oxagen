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
 *    decides WHICH types may exist, while this module
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
 * Coerce an arbitrary free-text type ("Nuclear-powered submarine", "pull_request",
 * "ISSUE") into a single **PascalCase** Neo4j label, or return null if nothing
 * usable remains.
 *
 * PascalCase is the canonical, human-readable label convention across the graph:
 * every node label a user ever sees (the structural `:Label` and the `label`
 * property the explorer groups/colours on) reads as `PullRequest`, never
 * `pull_request`, `PULL_REQUEST`, or `pullRequest`. Casing is normalised
 * regardless of how the source (a connector, the LLM, a customer) spelled the
 * type, so the same concept never splinters into differently-cased labels.
 *
 * Rules: split into word tokens on any run of non-alphanumeric characters AND on
 * camelCase humps (lower→upper boundaries); Title-case each token (first char
 * upper, rest lower — this also flattens SCREAMING_SNAKE input); concatenate;
 * prefix `N` when the result would start with a digit; cap at 99 chars. The
 * result always satisfies `isValidLabel`, and the function is idempotent on
 * already-PascalCase input.
 *
 *   "Nuclear-powered submarine" → "NuclearPoweredSubmarine"
 *   "pull_request"              → "PullRequest"
 *   "PULL_REQUEST"              → "PullRequest"
 *   "issue"                     → "Issue"
 *   "GraphNode"                 → "GraphNode"   (idempotent)
 *   "3D model"                  → "N3dModel"
 *   "!!!"                       → null
 */
export function sanitizeLabel(raw: string): string | null {
  const words = raw
    .trim()
    // Insert a separator at camelCase humps so "pullRequest" tokenises the same
    // way "pull_request" does — both collapse to the same canonical PascalCase.
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  let pascal = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  // A Neo4j label must start with a letter; prefix `N` for digit-leading results.
  if (!/^[A-Za-z]/.test(pascal)) pascal = `N${pascal}`;
  const capped = pascal.slice(0, 99);
  return isValidLabel(capped) ? capped : null;
}

/**
 * Normalised, separator- and case-insensitive identity key for a label or type.
 * Used for vocabulary-membership comparisons where "pull_request", "PullRequest",
 * and "pull request" must all be treated as the same type. Because it routes
 * through `sanitizeLabel` (which strips separators and canonicalises case) then
 * lower-cases, every spelling of one concept collapses to a single key.
 *
 *   toLabelKey("pull_request") === toLabelKey("PullRequest") === "pullrequest"
 *
 * Returns "" when the input has no usable label characters, so an unusable type
 * can never accidentally match a real vocabulary entry.
 */
export function toLabelKey(raw: string): string {
  return sanitizeLabel(raw)?.toLowerCase() ?? "";
}

/**
 * The relationship type assigned when a model- or customer-supplied type cannot
 * be coerced into a valid Neo4j relationship type. A materialised edge MUST carry
 * a type (Cypher has no "untyped" relationship), so unlike `sanitizeLabel` the
 * relationship-type coercion never returns null — it falls back to this constant.
 */
export const FALLBACK_RELATIONSHIP_TYPE = "RELATED_TO" as const;

/**
 * Coerce an arbitrary, descriptive relationship type ("depends on", "implements",
 * "PART_OF") into a single valid, UPPER_SNAKE_CASE Neo4j relationship type.
 *
 * Relationship types, exactly like labels, CANNOT be parameterized in Cypher
 * (`MERGE (a)-[r:$type]->(b)` is illegal), so any non-constant type written into
 * a query string MUST pass through here first — it is an injection surface. The
 * output always satisfies `isValidLabel`, so it is safe to interpolate directly
 * into a relationship-type position.
 *
 * Rules: uppercase; collapse any run of non-alphanumeric characters to a single
 * underscore; trim leading/trailing underscores; prefix `REL_` when the result
 * would start with a digit; cap at 99 chars; fall back to RELATED_TO when nothing
 * usable remains.
 *
 *   "depends on"  → "DEPENDS_ON"
 *   "implements"  → "IMPLEMENTS"
 *   "PART_OF"     → "PART_OF"
 *   "3-way merge" → "REL_3_WAY_MERGE"
 *   "!!!"         → "RELATED_TO"
 */
export function sanitizeRelationshipType(raw: string): string {
  const collapsed = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (collapsed.length === 0) return FALLBACK_RELATIONSHIP_TYPE;
  const prefixed = /^[A-Z]/.test(collapsed) ? collapsed : `REL_${collapsed}`;
  // Cap, then re-trim a trailing underscore the 99-char slice could re-introduce.
  const capped = prefixed.slice(0, 99).replace(/_+$/g, "");
  return isValidLabel(capped) ? capped : FALLBACK_RELATIONSHIP_TYPE;
}
