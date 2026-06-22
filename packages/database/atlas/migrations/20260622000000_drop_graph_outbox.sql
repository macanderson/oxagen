-- OXA-1779 follow-up: drop the never-wired graph.* transactional-outbox tables.
--
-- graph.outbox + graph.projection_checkpoints were created in the initial
-- schema (20260611233016) for a Postgres -> Neo4j transactional-outbox/projector
-- pattern that was never wired: zero writers and zero readers in app/packages
-- code. The graph projection runs directly from the Inngest
-- sync-execution-to-graph function, and Neo4j is rebuildable from Postgres at
-- any time, so the outbox buys nothing today.
--
-- graph.outbox carried org_id and a tenant_isolation RLS policy, so it was in
-- POLICY_MANIFEST; removing it from the manifest (done in this PR) requires the
-- table to actually be gone, otherwise the RLS manifest-coverage integration
-- test fails ("table with org_id not in manifest or allowlist"). CASCADE drops
-- the table's indexes, identity sequence, RLS policy, and grants together.
--
-- projection_checkpoints only tracked the outbox high-water mark, so it goes
-- with it. No graph.* tenant tables remain after this; the empty "graph"
-- Postgres schema is left in place for future graph-projection work.
DROP TABLE IF EXISTS "graph"."projection_checkpoints";
DROP TABLE IF EXISTS "graph"."outbox" CASCADE;
