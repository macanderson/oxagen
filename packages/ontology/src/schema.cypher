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
