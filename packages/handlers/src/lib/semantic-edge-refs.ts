/**
 * semantic-edge-refs.ts — shared helpers for resolving the friendly, inspectable
 * endpoint + relationship citations returned by the semantic-edge capabilities.
 *
 * Neo4j stores a node's property bag as a JSON string and exposes the inferred
 * relationship's own attributes (model, connector, status, timestamps) directly
 * on the `:InferredEdge` node. Both `semantic.edge.suggest` and
 * `semantic.edge.list` need to turn those raw columns into the contract's
 * `KnowledgeNodeRef` shape and a clean relationship property bag, so the logic
 * lives here once rather than being copy-pasted across the two handlers.
 */

/**
 * Parse a node's stored property bag. Neo4j persists it as a JSON string (see
 * `graph.node.list`), but tolerate an already-parsed object or a null/absent
 * value so the helper is safe across drivers and test fixtures.
 */
export function parseNodeProperties(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    if (raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * Build the relationship's own property bag for hover/inspect detail. Only the
 * user-meaningful inference metadata is surfaced — the raw `semanticPrompt` and
 * tenant-internal keys are intentionally excluded. Empty/absent values are
 * dropped so the detail card never shows blank rows.
 */
export function buildRelationshipProperties(fields: {
  relationshipType: string;
  confidence: number;
  model?: string | null;
  connector?: string | null;
  inferredAt?: string | null;
  approvalStatus?: string | null;
}): Record<string, unknown> {
  const props: Record<string, unknown> = {
    relationshipType: fields.relationshipType,
    confidence: fields.confidence,
  };
  if (fields.model) props.model = fields.model;
  if (fields.connector) props.connector = fields.connector;
  if (fields.inferredAt) props.inferredAt = fields.inferredAt;
  if (fields.approvalStatus) props.approvalStatus = fields.approvalStatus;
  return props;
}
