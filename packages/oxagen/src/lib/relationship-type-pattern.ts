/**
 * Cypher-injection lexical guard for relationship types (§3.2).
 *
 * Enforces Neo4j's recommended uppercase-snake relationship-type convention.
 * Every relationship type interpolated into a Cypher query MUST match this
 * pattern before it reaches the driver — this closes the injection vector
 * regardless of the workspace registry allow-list.
 *
 * Pattern: uppercase letter followed by up to 62 uppercase letters, digits, or
 * underscores — identical to Neo4j's own relationship-type identifier rules.
 */
export const RELATIONSHIP_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;
