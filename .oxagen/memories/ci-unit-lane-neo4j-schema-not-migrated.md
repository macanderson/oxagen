---
name: ci-unit-lane-neo4j-schema-not-migrated
type: bug
domain: ci
severity: P1
linear: OXA-2076
date: 2026-07-04
---

**Symptom:** Neo4j-backed integration tests that live in the `test:unit` lane
(`packages/ontology/.../file-lock.integration.test.ts`,
`packages/ingestion/.../resolve.integration.test.ts`) failed in CI with
"There is no such vector schema index: entity_node_embedding_index" and a
"Test timed out in 5000ms" on the two-agent file-lock race — while passing
locally.

**Root cause:** The CI "Build and unit tests (affected)" job's "Detect migration
changes" gate (`.github/workflows/pipeline.yml`) only ran the "Migrate
ClickHouse and Neo4j" step when a `packages/database/atlas/migrations/` or
`packages/telemetry/` file changed. A **schema.cypher-only** change (PR #613
added the `source_file_natural_key_org_unique` composite constraint; the
`entity_node_embedding_index` vector index was already there) — or any run where
ontology/ingestion are "affected" through a dependency with no migration diff —
left the bare Neo4j service container **unmigrated**. The vector query then threw
(no index), and the concurrent `MERGE (:SourceFile {naturalKey, orgId})` in the
lock race did not serialise without its backing uniqueness constraint (double-
grant locally, lock-wait hang → 5s timeout in CI).

**Fix:**
1. Broadened the CI gate grep to also trigger on `packages/ontology/src/*.cypher`.
2. Made both integration suites **hermetic**: their `beforeAll` now idempotently
   ensures the one schema object each depends on (`CREATE ... IF NOT EXISTS` +
   `CALL db.awaitIndexes`), so they pass whether or not the CI migrate step ran.

**Guard:** Reproduced by dropping the index/constraint from local Neo4j and
running the origin-main tests (both failed with the exact CI errors); the fixed
suites self-provision the schema and pass against the emptied graph.

**Watch-outs:** Any new Neo4j-dependent test that runs in the `test:unit` lane
must NOT assume the graph is migrated — either ensure its schema in `beforeAll`
or the migrate gate must cover the file that defines that schema. The unit-lane
Neo4j service is bare and migrated only conditionally.
