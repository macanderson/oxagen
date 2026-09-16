# ADR-003 — Neo4j as vector store

**Date:** 2026-05-27
**Status:** Accepted
**Epic:** Foundations

## Context

Spec §8 requires semantic retrieval over documents, agent memories, and
chat messages. The candidates are `pgvector` inside Postgres and
Neo4j's native vector index (5.13+).

## Decision

Use **Neo4j** as the vector store. Embeddings are vector properties on
graph nodes (`Document`, `AgentMemory`, `Message`) indexed with
Neo4j's native vector index (`cosine`, 1536 dims to match
`text-embedding-3-small`). `pgvector` is **not** used.

## Alternatives considered

- **pgvector inside Postgres (Neon).** Operationally simpler, one fewer
  store. Recall queries that also traverse
  `REFERENCES`/`REMEMBERS`/`SIMILAR_TO` edges would become cross-DB
  joins. CLAUDE.md positions Neo4j as the semantic-retrieval store.
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

## Amendment 2026-09-15: Neo4j is not retired (maintainer decision)

The scale-back review of 2026-09-14 left Neo4j's future open. The
maintainer decided on 2026-09-15 that Neo4j stays
(`apps/app/ARCHITECTURE.md` §9, 2026-09-15). This ADR stands as written:
no lane retires Neo4j, and no ADR to retire it is planned. The witness
plane and the run record (ADR-058, which defers the `:Run` / `:Frame`
projection) are later readers of the graph, and neither moves it. Every
Neo4j dependency, schema runner and `NEO4J_*` variable stays.
