// Semantic edge inference — Neo4j schema additions for Phase 5.
//
// InferredEdge nodes store LLM-inferred relationship candidates that require
// human approval before being materialised as permanent :Relationship edges.
// All statements are idempotent (IF NOT EXISTS). Migrate runs each statement
// in its own transaction.

// --- Uniqueness constraints ---
CREATE CONSTRAINT inferred_edge_id IF NOT EXISTS
  FOR (n:InferredEdge) REQUIRE n.id IS UNIQUE;

// --- Range indexes for common filter/sort patterns ---
// Workspace-scoped approval-status sweep (primary query for the review UI)
CREATE INDEX inferred_edge_workspace_status IF NOT EXISTS
  FOR (n:InferredEdge) ON (n.workspaceId, n.approvalStatus);

// Confidence-based sorting (secondary, applies after workspace/status filter)
CREATE INDEX inferred_edge_confidence IF NOT EXISTS
  FOR (n:InferredEdge) ON (n.confidence);

// Connector-scoped listing (bulk-approve-by-connector flow)
CREATE INDEX inferred_edge_connection IF NOT EXISTS
  FOR (n:InferredEdge) ON (n.workspaceId, n.connectionId);

// Approved-edge lookup (permanent edge browser in semantic-edge-viewer)
CREATE INDEX inferred_edge_approved IF NOT EXISTS
  FOR (n:InferredEdge) ON (n.workspaceId, n.approvalStatus, n.approvedAt);

// --- InferredEdge property schema (documented; no explicit DDL required) ---
//
// Properties every InferredEdge carries:
//   id               : UUID — uniqueness key above
//   orgId            : string — tenant scope
//   workspaceId      : string — workspace scope
//   sourceNodeId     : string — publicId of the source EntityNode
//   targetType       : string — inferred target label (e.g. "Feature", "Service")
//   targetName       : string — inferred target display name
//   relationshipType : string — inferred relationship kind (e.g. "IMPLEMENTS")
//   confidence       : float  — 0.0–1.0 LLM confidence
//   approvalStatus   : "pending" | "approved" | "rejected"
//   approvedBy       : string? — userId who acted on this edge
//   approvedAt       : datetime? — when the action was taken
//   comment          : string? — reviewer's optional note
//   llmModel         : string  — gateway model id that created the inference
//   semanticPrompt   : string  — exact prompt used (for reproducibility / audit)
//   connectionId     : string  — connector that produced the source node
//   inferredAt       : datetime — when inference ran

// --- Permanent Relationship node (created on approval) ---
// Permanent edges are represented as Neo4j relationships, not nodes.
// On approval the handler creates:
//   (:EntityNode {publicId: sourceNodeId})-[:SEMANTIC_EDGE {
//     type: relationshipType, confidence: confidence,
//     inferredEdgeId: id, approvedBy: userId, approvedAt: datetime
//   }]->(:EntityNode|:KnowledgeNode {type: targetType, name: targetName})
//
// For target nodes that don't yet exist as EntityNodes the handler does a
// MERGE on (orgId, workspaceId, targetType, targetName) creating a placeholder
// :KnowledgeNode that subsequent ingestion can enrich.
