/**
 * Lexical guard for Neo4j NODE LABELS that are interpolated into Cypher.
 *
 * Neo4j cannot parameterize a label (`SET n:$label` is invalid), so a label
 * string is concatenated into the query text — exactly the Cypher-injection
 * surface that `RELATIONSHIP_TYPE_PATTERN` closes for relationship types.
 *
 * The pattern is deliberately permissive about CASE (labels are conventionally
 * PascalCase like `Customer`, `Billing`, but domain labels and ingested types
 * vary) while forbidding everything that could break out of the label token:
 * whitespace, backticks, colons, parens, brackets. Identifier rules: starts
 * with a letter, then letters / digits / underscore, max 63 chars.
 *
 * SCOPE — read before relying on this. Nothing currently calls it: this module
 * has no importers, and it is not listed in this package's `exports` map, so it
 * cannot be reached from another package either. The guard that Cypher label
 * seams actually run is `assertValidLabel` in `packages/ontology/src/labels.ts`,
 * and that copy allows a LONGER label (99 chars) than this one. Treat the two as
 * unreconciled until one is deleted in favour of the other; do not cite this
 * file as evidence that a given seam is guarded.
 */
export const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/** Throwing assertion used at every Cypher seam that interpolates a label. */
export function assertSafeLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `Invalid node label "${label}": must match ${LABEL_PATTERN} (letter, then letters/digits/underscore, ≤63 chars)`,
    );
  }
}
