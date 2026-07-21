// Spec §8. Constraints + indexes + vector indexes. Neo4j 5.13+ required
// for native vector indexes.
//
// All statements are idempotent (IF NOT EXISTS). Migrate.ts runs each
// statement in its own transaction.

// Retire the legacy semantic-inference review schema without deleting its data.
// Operational cleanup can remove drained :InferredEdge nodes separately.
DROP INDEX inferred_edge_workspace_status IF EXISTS;
DROP INDEX inferred_edge_confidence IF EXISTS;
DROP INDEX inferred_edge_connection IF EXISTS;
DROP INDEX inferred_edge_approved IF EXISTS;
DROP CONSTRAINT inferred_edge_id IF EXISTS;

// --- Uniqueness constraints on publicId (spec §4.3) ---
CREATE CONSTRAINT tenant_public_id IF NOT EXISTS FOR (n:Tenant) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT workspace_public_id IF NOT EXISTS FOR (n:Workspace) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT user_public_id IF NOT EXISTS FOR (n:User) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT agent_public_id IF NOT EXISTS FOR (n:Agent) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT agent_version_public_id IF NOT EXISTS FOR (n:AgentVersion) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT tool_public_id IF NOT EXISTS FOR (n:Tool) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT tool_version_public_id IF NOT EXISTS FOR (n:ToolVersion) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT playbook_public_id IF NOT EXISTS FOR (n:Playbook) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT playbook_version_public_id IF NOT EXISTS FOR (n:PlaybookVersion) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT execution_public_id IF NOT EXISTS FOR (n:Execution) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT fanout_public_id IF NOT EXISTS FOR (n:Fanout) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT document_public_id IF NOT EXISTS FOR (n:Document) REQUIRE n.publicId IS UNIQUE;
// Retire the automatic generated-file graph projection without deleting data.
// Operational cleanup may remove drained :GeneratedFile nodes separately.
DROP INDEX generated_file_org IF EXISTS;
DROP CONSTRAINT generated_file_public_id IF EXISTS;
CREATE CONSTRAINT agent_memory_public_id IF NOT EXISTS FOR (n:AgentMemory) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT conversation_public_id IF NOT EXISTS FOR (n:Conversation) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT message_public_id IF NOT EXISTS FOR (n:Message) REQUIRE n.publicId IS UNIQUE;

// --- Agent runtime epic (spec §6, agent-runtime) ---
CREATE CONSTRAINT skill_public_id IF NOT EXISTS FOR (n:Skill) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT skill_version_public_id IF NOT EXISTS FOR (n:SkillVersion) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT background_task_public_id IF NOT EXISTS FOR (n:BackgroundTask) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT plan_public_id IF NOT EXISTS FOR (n:Plan) REQUIRE n.publicId IS UNIQUE;

// --- Two-axis memory model (docs/specs/two-axis-memory) ---
// Citation/Promotion/Evidence back the confidence ladder (OBSERVATION→RULE→FACT),
// citation-driven confidence recovery, and auditable promotions. :Execution
// already has execution_public_id above; these three are new node types.
CREATE CONSTRAINT citation_id IF NOT EXISTS FOR (n:Citation) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT promotion_id IF NOT EXISTS FOR (n:Promotion) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT demotion_id IF NOT EXISTS FOR (n:Demotion) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT evidence_id IF NOT EXISTS FOR (n:Evidence) REQUIRE n.id IS UNIQUE;

// New edge types (no Cypher DDL required; documented here for the registry):
//   INVOKED              :Execution -> :ToolVersion (one per tool call)
//   LOADED_SKILL         :AgentVersion -> :SkillVersion
//   BRANCHED_TO_SUBAGENT :Message -> :Message (parent fanout to child)
//   APPROVED_BY          :Execution -> :User (approval audit)
//   PROMOTED             :Promotion -> :Memory (auditable class promotion)
//   DEMOTED              :Demotion -> :Memory (auditable class demotion)

// --- Org-scope range indexes for fast filtering ---
// Runtime writes/filters nodes on `orgId` (see packages/agent/src/memory/neo4j.ts
// `WHERE node.orgId = $orgId`), so the scope indexes MUST be on `orgId`. The old
// `tenantId` indexes were dead (no node carries that property) and left orgId
// lookups unindexed.
CREATE INDEX execution_org IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
CREATE INDEX fanout_org IF NOT EXISTS FOR (n:Fanout) ON (n.orgId);
CREATE INDEX document_org IF NOT EXISTS FOR (n:Document) ON (n.orgId);
CREATE INDEX message_conversation IF NOT EXISTS FOR (n:Message) ON (n.conversationId);
CREATE INDEX agent_memory_org IF NOT EXISTS FOR (n:AgentMemory) ON (n.orgId);
CREATE INDEX background_task_org IF NOT EXISTS FOR (n:BackgroundTask) ON (n.orgId);

// --- Two-axis memory model — filter/sort indexes ---
// Reads filter on status='ACTIVE' and the two axes; the promotion-candidate UI
// sorts promotable observations by citation pressure (memory_class, citation_count).
CREATE INDEX agent_memory_class_kind IF NOT EXISTS FOR (n:AgentMemory) ON (n.memory_class, n.memory_kind);
CREATE INDEX agent_memory_status IF NOT EXISTS FOR (n:AgentMemory) ON (n.status);
CREATE INDEX agent_memory_promotion_pressure IF NOT EXISTS FOR (n:AgentMemory) ON (n.memory_class, n.citation_count);
// Dismissed candidates are excluded from the promotion window (listPromotionCandidates
// filters `promotion_dismissed_at IS NULL`); index the marker so that filter is cheap.
CREATE INDEX agent_memory_promotion_dismissed IF NOT EXISTS FOR (n:AgentMemory) ON (n.promotion_dismissed_at);
CREATE INDEX citation_org IF NOT EXISTS FOR (n:Citation) ON (n.orgId);
CREATE INDEX promotion_org IF NOT EXISTS FOR (n:Promotion) ON (n.orgId);
CREATE INDEX demotion_org IF NOT EXISTS FOR (n:Demotion) ON (n.orgId);
CREATE INDEX evidence_org IF NOT EXISTS FOR (n:Evidence) ON (n.orgId);

// --- Ingestion pipeline — SourceConnection (fixed system node) ---
// naturalKey on EntityNode: "{connectorId}:{connectionId}:{externalId}"
// entityType on EntityNode: customer-configured string (e.g. "task", "contact")
CREATE CONSTRAINT source_connection_id IF NOT EXISTS FOR (n:SourceConnection) REQUIRE n.id IS UNIQUE;
CREATE INDEX entity_node_workspace IF NOT EXISTS FOR (n:EntityNode) ON (n.workspaceId, n.entityType);
CREATE INDEX entity_node_natural_key IF NOT EXISTS FOR (n:EntityNode) ON (n.naturalKey);
CREATE INDEX entity_node_connection IF NOT EXISTS FOR (n:EntityNode) ON (n.connectionId);
CREATE INDEX ingestion_org_source IF NOT EXISTS FOR (n:SourceConnection) ON (n.orgId);

// --- Vector indexes (spec §8.1) ---
CREATE VECTOR INDEX document_embedding_index IF NOT EXISTS
FOR (n:Document) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
FOR (n:AgentMemory) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// Retire the automatic EngramMemory projection without deleting legacy nodes.
DROP INDEX engram_memory_org IF EXISTS;
DROP INDEX engram_memory_embedding_index IF EXISTS;

CREATE VECTOR INDEX message_embedding_index IF NOT EXISTS
FOR (n:Message) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// Retire semantic execution-summary projection/recall without deleting
// :Execution nodes used by the explicit memory-citation model.
DROP INDEX execution_embedding_index IF EXISTS;

// Universal vector index for all ingested entity nodes.
// All customer ontology nodes carry the :EntityNode label regardless of entityType.
// Workspace-scoped queries pre-filter by workspaceId before vector search.
// 1536 dims = text-embedding-3-small via Vercel AI Gateway.
CREATE VECTOR INDEX entity_node_embedding_index IF NOT EXISTS
FOR (n:EntityNode) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// Retired launch surface: detailed source-code graphs stay checkout-local.
// Drop legacy server indexes/constraints; derived nodes can be removed by the
// operational cleanup after in-flight ingestion jobs have drained.
DROP INDEX source_file_natural_key IF EXISTS;
DROP INDEX source_file_org IF EXISTS;
DROP INDEX source_file_connection IF EXISTS;
DROP INDEX source_symbol_natural_key IF EXISTS;
DROP INDEX source_symbol_org IF EXISTS;
DROP INDEX source_symbol_file IF EXISTS;
DROP INDEX source_chunk_natural_key IF EXISTS;
DROP INDEX source_chunk_org IF EXISTS;
DROP INDEX source_chunk_file IF EXISTS;
DROP INDEX source_file_embedding_index IF EXISTS;
DROP INDEX source_symbol_embedding_index IF EXISTS;
DROP INDEX source_chunk_embedding_index IF EXISTS;
DROP CONSTRAINT source_file_public_id IF EXISTS;
DROP CONSTRAINT source_file_natural_key_org_unique IF EXISTS;
DROP CONSTRAINT source_symbol_public_id IF EXISTS;
DROP CONSTRAINT source_chunk_public_id IF EXISTS;

// Retire the legacy inferred-feature projection. Customer ontologies may still
// use "Feature" as an ordinary EntityNode label; it no longer receives a
// privileged system schema or embedding index.
DROP INDEX feature_natural_key IF EXISTS;
DROP INDEX feature_org IF EXISTS;
DROP INDEX feature_embedding_index IF EXISTS;
DROP CONSTRAINT feature_public_id IF EXISTS;

// --- Universal graph node anchor (:GraphNode) ----------------------------------
// Every tenant graph node — customer ontology AND product-owned (executions,
// memories, messages, documents) — carries the neutral :GraphNode anchor label IN
// ADDITION to its real domain label (:Submarine, :Execution, ...).
// The anchor exists ONLY to back per-label indexes/constraints: Neo4j cannot
// parameterize labels (MATCH (n:$label) is illegal) nor index across arbitrary
// runtime-defined customer labels, so id-lookup, scope filtering and the universal
// vector index need one fixed label to anchor. All "system vs customer" filtering
// is done via the `is_system` boolean property on nodes AND relationships, never a
// label (relationships cannot be multi-labeled). The legacy :KnowledgeNode marker
// is superseded. See memory: graph-node-anchor-and-is-system-model.
CREATE CONSTRAINT graph_node_public_id IF NOT EXISTS FOR (n:GraphNode) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX graph_node_scope IF NOT EXISTS FOR (n:GraphNode) ON (n.orgId, n.workspaceId);
CREATE INDEX graph_node_label IF NOT EXISTS FOR (n:GraphNode) ON (n.label);

// One universal vector index over ALL embedded graph nodes — a single
// db.index.vector.queryNodes('graph_node_embedding_index', ...) call performs
// natural-language semantic search across customer data, agent
// memories, executions, messages and documents at once, post-filtered by
// orgId/workspaceId + optional is_system/label. 1536 dims = text-embedding-3-small.
CREATE VECTOR INDEX graph_node_embedding_index IF NOT EXISTS
FOR (n:GraphNode) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// --- One-time relabel: :KnowledgeNode -> :GraphNode + is_system backfill ---------
// Each statement is gated `WHERE NOT n:GraphNode` so it scans only un-migrated nodes
// and no-ops on every subsequent migrate (naturally idempotent). Product-owned types
// are migrated first (is_system=true) so the trailing :KnowledgeNode catch-all only
// captures genuine customer ontology nodes (is_system=false). publicId is backfilled
// where missing so executions/memories/messages/documents are id-addressable.
MATCH (n:Execution)    WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:AgentMemory)  WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());

// --- Two-axis memory backfill (docs/specs/two-axis-memory) ---
// Idempotent: gated on `memory_class IS NULL` so it scans only un-migrated
// memories and no-ops on every subsequent run. Maps the legacy flat model
// (weight + kind + confidence 0-1) onto the two-axis model:
//   - critical/high weight → RULE with enforcement 95/70; low/other → OBSERVATION
//   - confidence 0-1 → confidence_score 0-100
//   - source → created_by_kind (user→USER, feature/fix→AGENT, else SYSTEM)
MATCH (n:AgentMemory)
WHERE n.memory_class IS NULL
SET n.confidence_score = coalesce(n.confidence, 1.0) * 100.0,
    n.memory_class = CASE WHEN n.weight IN ['critical','high'] THEN 'RULE' ELSE 'OBSERVATION' END,
    n.enforcement_score = CASE n.weight WHEN 'critical' THEN 95 WHEN 'high' THEN 70 ELSE null END,
    n.memory_kind = coalesce(n.kind, 'constraint'),
    n.half_life_days = CASE WHEN n.weight IN ['critical','high'] THEN 90.0 ELSE 30.0 END,
    n.decay_floor = 5.0,
    n.last_evidence_at = coalesce(n.lastReinforcedAt, n.createdAt, datetime()),
    n.citation_count = coalesce(n.citation_count, 0),
    n.influence_count = coalesce(n.influence_count, 0),
    n.violation_count = coalesce(n.violation_count, 0),
    n.status = coalesce(n.status, 'ACTIVE'),
    n.created_by_kind = CASE n.source WHEN 'user' THEN 'USER' WHEN 'feature' THEN 'AGENT' WHEN 'fix' THEN 'AGENT' WHEN 'exception-watcher' THEN 'AGENT' ELSE 'SYSTEM' END,
    n.created_by_id = coalesce(n.source, 'system'),
    n.subject_hint = coalesce(n.nodeRef, '');
MATCH (n:Message)      WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:Document)     WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:KnowledgeNode) WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = false REMOVE n:KnowledgeNode;
// Final unconditional sweep: retire the legacy :KnowledgeNode label everywhere,
// including nodes already promoted to :GraphNode by an earlier statement above
// (preserves whatever is_system they were assigned). No-ops once none remain.
MATCH (n:KnowledgeNode) SET n:GraphNode, n.is_system = coalesce(n.is_system, false) REMOVE n:KnowledgeNode;
