/**
 * Integration test proving Pass-A of resolveEntity binds `$orgId` into the
 * Cypher params it passes to `session.run()`. Neo4j treats an unbound
 * parameter as `null`, so an unbound `orgId: $orgId` would never match an
 * existing principal (`orgId = null` is never true) — every re-delivery of
 * the same naturalKey (e.g. a webhook retry, or a polling overlap) would fall
 * through to Pass B and create a duplicate principal instead of updating the
 * existing one.
 *
 * A parameter silently evaluating to `null` inside a MATCH clause cannot be
 * reproduced with a mocked Neo4j session (a mock can't reject/short-circuit a
 * query the way the real driver's parameter binding does), so this test runs
 * `resolveEntity` against the real local Neo4j instance
 * (`bolt://localhost:7687`, started by `pnpm dev`) and skips cleanly when it
 * is unreachable (e.g. the CI unit lane).
 *
 * Only `embedText` (@oxagen/ai) is mocked — Pass B's embedding call hits a
 * paid AI Gateway and is not what this test checks. Everything else
 * (scopedSession, the real Cypher, upsertEntityNode) runs for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

process.env.NEO4J_URI ??= "bolt://localhost:7687";
process.env.NEO4J_USERNAME ??= "neo4j";
process.env.NEO4J_PASSWORD ??= "oxagen-dev";
process.env.NEO4J_DATABASE ??= "neo4j";

vi.mock("@oxagen/ai", () => ({
  embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}));

const { runInTenantScope } = await import("@oxagen/tenancy");
const { driver, closeDriver } = await import("@oxagen/ontology/client");
const { resolveEntity } = await import("../resolve");

import type { EntityMutation } from "../../types";

// Fixed, valid-UUID-shaped tenant scope, distinct from other integration
// suites' fixture ids so a parallel test run can never collide on the same
// naturalKey+orgId node.
const ORG_ID = "00000000-0000-4000-8000-0000000da052";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000da053";
const NATURAL_KEY = "github:oxa-2052-dedup-regression:redelivered-42";

function makeMutation(overrides: Partial<EntityMutation> = {}): EntityMutation {
  return {
    workspaceId: WORKSPACE_ID,
    orgId: ORG_ID,
    connectionId: "conn-oxa-2052",
    entityType: "task",
    sourceRecordType: "issue",
    naturalKey: NATURAL_KEY,
    operation: "insert",
    displayName: "OXA-2052 dedup regression fixture",
    properties: { title: "OXA-2052 dedup regression fixture" },
    sourceRef: {
      connectorType: "github",
      connectionId: "conn-oxa-2052",
      externalId: "42",
    },
    ...overrides,
  };
}

let neo4jUp = false;

/**
 * Ensure the vector index `resolveEntity` Pass B queries
 * (`CALL db.index.vector.queryNodes('entity_node_embedding_index', ...)`) exists.
 * Without it Neo4j throws "There is no such vector schema index:
 * entity_node_embedding_index" — the exact CI unit-lane failure.
 *
 * `pnpm dev` applies this via `db:migrate` (schema.cypher), but the CI unit lane
 * uses a bare Neo4j service container and only runs the Neo4j migrate step when a
 * Postgres/telemetry migration changed. An ontology-source ("affected") run with
 * no migration diff leaves the graph unmigrated, so this suite ensures its one
 * required index idempotently (`IF NOT EXISTS`) and is hermetic regardless of the
 * CI migrate gating. Mirrors schema.cypher.
 */
async function ensureDedupSchema(): Promise<void> {
  const s = driver().session({ database: process.env.NEO4J_DATABASE });
  try {
    await s.run(
      `CREATE VECTOR INDEX entity_node_embedding_index IF NOT EXISTS
       FOR (n:EntityNode) ON (n.embedding)
       OPTIONS { indexConfig: { \`vector.dimensions\`: 1536, \`vector.similarity_function\`: 'cosine' } }`,
    );
    // The vector index must be ONLINE before Pass B can query it by name;
    // no-op once it already exists.
    await s.run("CALL db.awaitIndexes(30000)");
  } catch (err) {
    // Tolerate a parallel integration suite winning the same idempotent create.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|equivalent/i.test(msg)) throw err;
  } finally {
    await s.close();
  }
}

async function cleanupFixtureNodes(): Promise<void> {
  const s = driver().session({ database: process.env.NEO4J_DATABASE });
  try {
    await s.run(
      `MATCH (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId}) DETACH DELETE n`,
      { naturalKey: NATURAL_KEY, orgId: ORG_ID },
    );
  } finally {
    await s.close();
  }
}

beforeAll(async () => {
  try {
    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      await s.run("RETURN 1");
    } finally {
      await s.close();
    }
    neo4jUp = true;
    await ensureDedupSchema();
    await cleanupFixtureNodes();
  } catch (err) {
    console.error(
      "resolve.integration: local Neo4j unreachable — skipping:",
      err instanceof Error ? err.message : err,
    );
    neo4jUp = false;
  }
});

afterAll(async () => {
  if (neo4jUp) {
    await cleanupFixtureNodes();
    await closeDriver();
  }
});

describe("resolveEntity (integration, local Neo4j) — $orgId binding", () => {
  it("re-delivering the same naturalKey+orgId matches the existing principal instead of creating a duplicate", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const mutation = makeMutation();

    // First delivery: no existing node → Pass A miss → Pass B (no candidates,
    // embedText mocked) → a brand-new principal is created.
    const first = await runInTenantScope(
      { orgId: ORG_ID, workspaceId: WORKSPACE_ID },
      () => resolveEntity(mutation, ORG_ID),
    );
    expect(first.action).toBe("created_principal");
    expect(first.principalNodeId).toBeTruthy();

    // Second delivery of the SAME naturalKey+orgId (e.g. a webhook retry).
    // With $orgId correctly bound in Pass A's params, this MUST hit the
    // exact-match fast path and update the existing node rather than falling
    // through to Pass B and creating a duplicate.
    const second = await runInTenantScope(
      { orgId: ORG_ID, workspaceId: WORKSPACE_ID },
      () => resolveEntity(mutation, ORG_ID),
    );

    expect(second.action).toBe("updated_principal");
    expect(second.matchReason).toBe("natural_key_exact");
    expect(second.principalNodeId).toBe(first.principalNodeId);

    // Ground truth: exactly ONE node exists in the graph for this
    // naturalKey+orgId — the regression manifested as N duplicate nodes, one
    // per re-delivery.
    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      const countResult = await s.run(
        `MATCH (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId}) RETURN count(n) AS c`,
        { naturalKey: NATURAL_KEY, orgId: ORG_ID },
      );
      const count = countResult.records[0]?.get("c");
      expect(Number(count)).toBe(1);
    } finally {
      await s.close();
    }
  });

  it("a different orgId with the SAME naturalKey is a separate principal (tenant isolation holds)", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const otherOrgId = "00000000-0000-4000-8000-0000000da099";
    const otherWorkspaceId = "00000000-0000-4000-8000-0000000da098";

    try {
      const mutation = makeMutation({ orgId: ORG_ID });
      const home = await runInTenantScope(
        { orgId: ORG_ID, workspaceId: WORKSPACE_ID },
        () => resolveEntity(mutation, ORG_ID),
      );

      const otherMutation = makeMutation({
        orgId: otherOrgId,
        workspaceId: otherWorkspaceId,
      });
      const other = await runInTenantScope(
        { orgId: otherOrgId, workspaceId: otherWorkspaceId },
        () => resolveEntity(otherMutation, otherOrgId),
      );

      // Same naturalKey, different orgId → each org gets its own principal;
      // Pass A must not leak a match across tenants.
      expect(other.action).toBe("created_principal");
      expect(other.principalNodeId).not.toBe(home.principalNodeId);
    } finally {
      const s = driver().session({ database: process.env.NEO4J_DATABASE });
      try {
        await s.run(
          `MATCH (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId}) DETACH DELETE n`,
          { naturalKey: NATURAL_KEY, orgId: otherOrgId },
        );
      } finally {
        await s.close();
      }
    }
  });
});
