/**
 * Lexical guard for Neo4j NODE LABELS that are interpolated into Cypher.
 *
 * Neo4j cannot parameterize a label (`SET n:$label` is invalid), so a label
 * string is concatenated into the query text — exactly the Cypher-injection
 * surface that `RELATIONSHIP_TYPE_PATTERN` closes for relationship types. Any
 * label that reaches a `SET n:<label>` / `REMOVE n:<label>` / `MATCH (n:<label>)`
 * clause MUST first match this pattern; anything else is rejected before it
 * touches a query.
 *
 * The pattern is deliberately permissive about CASE (labels are conventionally
 * PascalCase like `Customer`, `Billing`, but domain labels and ingested types
 * vary) while forbidding everything that could break out of the label token:
 * whitespace, backticks, colons, parens, brackets. Identifier rules: starts
 * with a letter, then letters / digits / underscore, max 63 chars.
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
