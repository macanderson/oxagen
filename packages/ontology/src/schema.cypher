// Spec §8. Constraints + indexes + vector indexes. Neo4j 5.13+ required
// for native vector indexes.
//
// All statements are idempotent (IF NOT EXISTS). Migrate.ts runs each
// statement in its own transaction.

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
CREATE CONSTRAINT document_public_id IF NOT EXISTS FOR (n:Document) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT generated_file_public_id IF NOT EXISTS FOR (n:GeneratedFile) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX generated_file_org IF NOT EXISTS FOR (n:GeneratedFile) ON (n.orgId);
CREATE CONSTRAINT agent_memory_public_id IF NOT EXISTS FOR (n:AgentMemory) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT conversation_public_id IF NOT EXISTS FOR (n:Conversation) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT message_public_id IF NOT EXISTS FOR (n:Message) REQUIRE n.publicId IS UNIQUE;

// --- Agent runtime epic (spec §6, agent-runtime) ---
CREATE CONSTRAINT skill_public_id IF NOT EXISTS FOR (n:Skill) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT skill_version_public_id IF NOT EXISTS FOR (n:SkillVersion) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT background_task_public_id IF NOT EXISTS FOR (n:BackgroundTask) REQUIRE n.publicId IS UNIQUE;
CREATE CONSTRAINT plan_public_id IF NOT EXISTS FOR (n:Plan) REQUIRE n.publicId IS UNIQUE;

// New edge types (no Cypher DDL required; documented here for the registry):
//   INVOKED              :Execution -> :ToolVersion (one per tool call)
//   LOADED_SKILL         :AgentVersion -> :SkillVersion
//   BRANCHED_TO_SUBAGENT :Message -> :Message (parent fanout to child)
//   APPROVED_BY          :Execution -> :User (approval audit)

// --- Org-scope range indexes for fast filtering ---
// Runtime writes/filters nodes on `orgId` (see packages/agent/src/memory/neo4j.ts
// `WHERE node.orgId = $orgId`), so the scope indexes MUST be on `orgId`. The old
// `tenantId` indexes were dead (no node carries that property) and left orgId
// lookups unindexed.
CREATE INDEX execution_org IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
CREATE INDEX document_org IF NOT EXISTS FOR (n:Document) ON (n.orgId);
CREATE INDEX message_conversation IF NOT EXISTS FOR (n:Message) ON (n.conversationId);
CREATE INDEX agent_memory_org IF NOT EXISTS FOR (n:AgentMemory) ON (n.orgId);
CREATE INDEX background_task_org IF NOT EXISTS FOR (n:BackgroundTask) ON (n.orgId);

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

CREATE VECTOR INDEX message_embedding_index IF NOT EXISTS
FOR (n:Message) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// Universal vector index for all ingested entity nodes.
// All customer ontology nodes carry the :EntityNode label regardless of entityType.
// Workspace-scoped queries pre-filter by workspaceId before vector search.
// 1536 dims = text-embedding-3-small via Vercel AI Gateway.
CREATE VECTOR INDEX entity_node_embedding_index IF NOT EXISTS
FOR (n:EntityNode) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// --- Source code ingestion — SourceFile, SourceSymbol, Feature ---
CREATE CONSTRAINT source_file_public_id IF NOT EXISTS FOR (n:SourceFile) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX source_file_natural_key IF NOT EXISTS FOR (n:SourceFile) ON (n.naturalKey);
CREATE INDEX source_file_org IF NOT EXISTS FOR (n:SourceFile) ON (n.orgId);
CREATE INDEX source_file_connection IF NOT EXISTS FOR (n:SourceFile) ON (n.connectionId);

CREATE CONSTRAINT source_symbol_public_id IF NOT EXISTS FOR (n:SourceSymbol) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX source_symbol_natural_key IF NOT EXISTS FOR (n:SourceSymbol) ON (n.naturalKey);
CREATE INDEX source_symbol_org IF NOT EXISTS FOR (n:SourceSymbol) ON (n.orgId);
CREATE INDEX source_symbol_file IF NOT EXISTS FOR (n:SourceSymbol) ON (n.fileNaturalKey);

CREATE CONSTRAINT feature_public_id IF NOT EXISTS FOR (n:Feature) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX feature_natural_key IF NOT EXISTS FOR (n:Feature) ON (n.naturalKey);
CREATE INDEX feature_org IF NOT EXISTS FOR (n:Feature) ON (n.orgId, n.workspaceId);

CREATE VECTOR INDEX source_file_embedding_index IF NOT EXISTS
FOR (n:SourceFile) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

CREATE VECTOR INDEX source_symbol_embedding_index IF NOT EXISTS
FOR (n:SourceSymbol) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

CREATE VECTOR INDEX feature_embedding_index IF NOT EXISTS
FOR (n:Feature) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// --- Universal graph node anchor (:GraphNode) ----------------------------------
// Every tenant graph node — customer ontology AND product-owned (executions, code,
// memories, messages, documents) — carries the neutral :GraphNode anchor label IN
// ADDITION to its real domain label (:Submarine, :Execution, :SourceFile, ...).
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
// natural-language semantic search across customer data, source code, agent
// memories, executions, messages and documents at once, post-filtered by
// orgId/workspaceId + optional is_system/label. 1536 dims = text-embedding-3-small.
CREATE VECTOR INDEX graph_node_embedding_index IF NOT EXISTS
FOR (n:GraphNode) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// --- Source code chunks (full-content embedding for similarity search) ----------
// A SourceFile body is split into overlapping :SourceChunk nodes, each embedded, so
// large files are fully searchable by content (not just by symbol name). Chunks
// carry the :GraphNode anchor + is_system=true and link via
// (:SourceFile)-[:HAS_CHUNK]->(:SourceChunk).
CREATE CONSTRAINT source_chunk_public_id IF NOT EXISTS FOR (n:SourceChunk) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX source_chunk_natural_key IF NOT EXISTS FOR (n:SourceChunk) ON (n.naturalKey);
CREATE INDEX source_chunk_org IF NOT EXISTS FOR (n:SourceChunk) ON (n.orgId);
CREATE INDEX source_chunk_file IF NOT EXISTS FOR (n:SourceChunk) ON (n.fileNaturalKey);
CREATE VECTOR INDEX source_chunk_embedding_index IF NOT EXISTS
FOR (n:SourceChunk) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// --- Execution searchability ----------------------------------------------------
// Agent/workflow executions are first-class searchable graph nodes: this vector
// index powers NL recall over run summaries (prompt, tools used, outcome).
CREATE VECTOR INDEX execution_embedding_index IF NOT EXISTS
FOR (n:Execution) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };

// --- One-time relabel: :KnowledgeNode -> :GraphNode + is_system backfill ---------
// Each statement is gated `WHERE NOT n:GraphNode` so it scans only un-migrated nodes
// and no-ops on every subsequent migrate (naturally idempotent). Product-owned types
// are migrated first (is_system=true) so the trailing :KnowledgeNode catch-all only
// captures genuine customer ontology nodes (is_system=false). publicId is backfilled
// where missing so executions/memories/messages/documents are id-addressable.
MATCH (n:SourceFile)   WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true REMOVE n:KnowledgeNode;
MATCH (n:SourceSymbol) WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true REMOVE n:KnowledgeNode;
MATCH (n:Feature)      WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true REMOVE n:KnowledgeNode;
MATCH (n:Execution)    WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:AgentMemory)  WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:Message)      WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:Document)     WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = true, n.publicId = coalesce(n.publicId, n.id, randomUUID());
MATCH (n:KnowledgeNode) WHERE NOT n:GraphNode SET n:GraphNode, n.is_system = false REMOVE n:KnowledgeNode;
// Final unconditional sweep: retire the legacy :KnowledgeNode label everywhere,
// including nodes already promoted to :GraphNode by an earlier statement above
// (preserves whatever is_system they were assigned). No-ops once none remain.
MATCH (n:KnowledgeNode) SET n:GraphNode, n.is_system = coalesce(n.is_system, false) REMOVE n:KnowledgeNode;
