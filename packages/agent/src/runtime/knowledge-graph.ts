/**
 * Returns true only when Neo4j env is fully configured AND the feature flag
 * KNOWLEDGE_GRAPH_ENABLED is not explicitly set to "false".
 *
 * Default is OFF — the app must be stable with no Neo4j wiring.
 */
export function isKnowledgeGraphEnabled(): boolean {
  if (process.env.KNOWLEDGE_GRAPH_ENABLED === "false") return false;
  const uri = process.env.NEO4J_URI;
  return typeof uri === "string" && uri.length > 0;
}
