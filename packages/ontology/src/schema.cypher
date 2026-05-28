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

// --- Tenant-scope range indexes for fast filtering ---
CREATE INDEX execution_tenant IF NOT EXISTS FOR (n:Execution) ON (n.tenantId);
CREATE INDEX document_tenant IF NOT EXISTS FOR (n:Document) ON (n.tenantId);
CREATE INDEX message_conversation IF NOT EXISTS FOR (n:Message) ON (n.conversationId);
CREATE INDEX agent_memory_tenant IF NOT EXISTS FOR (n:AgentMemory) ON (n.tenantId);
CREATE INDEX background_task_tenant IF NOT EXISTS FOR (n:BackgroundTask) ON (n.tenantId);

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
