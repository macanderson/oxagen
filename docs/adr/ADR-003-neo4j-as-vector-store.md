# ADR-003 — Neo4j as vector store

**Date:** 2026-05-27
**Status:** Accepted
**Epic:** Foundations

## Context

Spec §8 requires semantic retrieval over documents, agent memories, and
chat messages. Two viable options: `pgvector` inside Postgres, or
Neo4j's native vector index (5.13+).

## Decision

Use **Neo4j** as the vector store. Embeddings are vector properties on
graph nodes (`Document`, `AgentMemory`, `Message`) indexed with
Neo4j's native vector index (`cosine`, 1536 dims to match
`text-embedding-3-small`). `pgvector` is **not** used.

## Alternatives considered

- **pgvector inside Postgres (Neon).** Operationally simpler, one fewer
  store. But it strips us of the *graph* dimension — recall queries
  that also traverse `REFERENCES`/`REMEMBERS`/`SIMILAR_TO` edges become
  cross-DB joins. CLAUDE.md positions Neo4j as the semantic-retrieval
  store; honoring that boundary keeps it ergonomic.
- **Dedicated vector DB (Pinecone, Weaviate, Qdrant).** Adds a third
  retrieval store. No graph traversal. Vendor lock-in.

## Consequences

- Vector indexes declared in `packages/ontology/src/schema.cypher`:
  `document_embedding_index`, `memory_embedding_index`,
  `message_embedding_index`.
- Postgres rows with Neo4j-resident embeddings track sync state via an
  `embedding_status` column.
- Recall queries combine `db.index.vector.queryNodes(...)` with
  property filters on `tenantId`/`workspaceId` for tenant scope.
- Embedding writes are runner-only (no app-direct writes to Neo4j per
  spec §8.2 mutation contract).
- Tradeoff: Neo4j vector index is younger than pgvector. Acceptable for
  v1; reassess at 100M+ vectors.
