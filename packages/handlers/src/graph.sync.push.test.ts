/**
 * graph.sync.push handler unit tests.
 *
 * Strategy: mock scopedSession() / runInTenantScope() so no real Neo4j
 * connection is required. Verify:
 *   - Node MERGE Cypher scopes on BOTH orgId AND workspaceId
 *   - Edge MERGE looks up endpoints by naturalKey scoped to org+workspace
 *   - Edge type fails the lexical guard → skipped (no MERGE attempt), logged
 *   - Tombstones DETACH DELETE nodes matching the key set
 *   - Empty nodes / edges / tombstones → correct zero counts, no extra queries
 *   - Re-sending the same payload (idempotency) → handler succeeds (MERGE is
 *     inherently idempotent at the Cypher level — we verify the handler does
 *     not add any guard that prevents re-sends)
 *   - Session is closed even when a query throws
 *   - Count is correctly read from the `{low, high}` Neo4j integer format
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

vi.mock("@oxagen/ontology/labels", () => ({
  sanitizeLabel: (label: string) => {
    // Only uppercase letters/digits/underscores starting with a letter → valid
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) return label;
    return null;
  },
}));

vi.mock("@oxagen/ai", () => ({}));

import { graphSyncPushHandler } from "./graph.sync.push";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countResult(n: number) {
  return { records: [{ get: (k: string) => (k === "total" ? n : null) }] };
}

function tombResult(n: number) {
  return { records: [{ get: (k: string) => (k === "tombstoned" ? n : null) }] };
}

const BASE_INPUT = {
  source: "code" as const,
  idempotencyKey: "code:myrepo:sha1:sha2",
  nodes: [],
  edges: [],
};

beforeEach(() => {
  mocks.run.mockReset();
  mocks.close.mockReset();
  mocks.close.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("graphSyncPushHandler", () => {
  it("returns zero counts when nodes, edges, and tombstones are all empty", async () => {
    const result = await graphSyncPushHandler(BASE_INPUT, CTX);
    expect(result).toEqual({ nodesUpserted: 0, edgesUpserted: 0, tombstoned: 0 });
    // No queries issued
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("MERGEs nodes and returns the count from Neo4j", async () => {
    mocks.run
      // UNWIND node MERGE
      .mockResolvedValueOnce(countResult(2))
      // domain label SET (one call per distinct label)
      .mockResolvedValue({ records: [] });

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          {
            key: "code:myrepo:src/foo.ts",
            labels: ["SourceFile"],
            displayName: "foo.ts",
            properties: { language: "typescript" },
            isSystem: true,
          },
          {
            key: "code:myrepo:src/bar.ts",
            labels: ["SourceFile"],
            displayName: "bar.ts",
            properties: {},
            isSystem: true,
          },
        ],
      },
      CTX,
    );

    expect(result.nodesUpserted).toBe(2);
    expect(result.edgesUpserted).toBe(0);
    expect(result.tombstoned).toBe(0);
  });

  it("node MERGE Cypher scopes on BOTH orgId AND workspaceId", async () => {
    mocks.run.mockResolvedValue(countResult(1));

    await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          {
            key: "code:r:f.ts",
            labels: ["SourceFile"],
            displayName: "f.ts",
            properties: {},
            isSystem: true,
          },
        ],
      },
      CTX,
    );

    const mergeCypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(mergeCypher).toContain("orgId: $orgId");
    expect(mergeCypher).toContain("workspaceId: $workspaceId");
  });

  it("naturalKey for nodes is prefixed with sync:{source}:", async () => {
    mocks.run.mockResolvedValue(countResult(1));

    await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        source: "lineage",
        nodes: [
          {
            key: "lineage:session-abc:turn-1",
            labels: ["Session"],
            displayName: "Session abc",
            properties: {},
            isSystem: true,
          },
        ],
      },
      CTX,
    );

    const params = mocks.run.mock.calls[0]?.[1] as { nodes: Array<{ naturalKey: string }> };
    expect(params.nodes[0]?.naturalKey).toBe("sync:lineage:lineage:session-abc:turn-1");
  });

  it("MERGEs edges and returns the count", async () => {
    mocks.run
      // node MERGE
      .mockResolvedValueOnce(countResult(2))
      // domain label SET for SourceFile (skipped if no-op, but mock fires)
      .mockResolvedValueOnce({ records: [] })
      // edge MERGE for IMPORTS
      .mockResolvedValueOnce(countResult(1));

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          { key: "code:r:a.ts", labels: ["SourceFile"], displayName: "a.ts", properties: {}, isSystem: true },
          { key: "code:r:b.ts", labels: ["SourceFile"], displayName: "b.ts", properties: {}, isSystem: true },
        ],
        edges: [
          { sourceKey: "code:r:a.ts", targetKey: "code:r:b.ts", type: "IMPORTS" },
        ],
      },
      CTX,
    );

    expect(result.edgesUpserted).toBe(1);
  });

  it("edge MERGE Cypher looks up endpoints by naturalKey scoped to org+workspace", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(2))
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce(countResult(1));

    await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          { key: "code:r:a.ts", labels: ["SourceFile"], displayName: "a.ts", properties: {}, isSystem: true },
          { key: "code:r:b.ts", labels: ["SourceFile"], displayName: "b.ts", properties: {}, isSystem: true },
        ],
        edges: [{ sourceKey: "code:r:a.ts", targetKey: "code:r:b.ts", type: "IMPORTS" }],
      },
      CTX,
    );

    // Edge MERGE is the third call (after node MERGE + label SET)
    const edgeCypher = mocks.run.mock.calls[2]?.[0] as string;
    expect(edgeCypher).toContain("naturalKey: e.fromKey");
    expect(edgeCypher).toContain("naturalKey: e.toKey");
    expect(edgeCypher).toContain("orgId: $orgId");
    expect(edgeCypher).toContain("workspaceId: $workspaceId");
    expect(edgeCypher).toContain(":IMPORTS");
  });

  it("valid edge type IMPORTS passes the lexical guard and triggers a MERGE", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))   // node MERGE
      .mockResolvedValueOnce({ records: [] })  // domain label SET
      .mockResolvedValueOnce(countResult(0));  // edge MERGE (returns 0 — mock)

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [{ key: "code:r:a.ts", labels: ["SourceFile"], displayName: "a.ts", properties: {}, isSystem: true }],
        edges: [{ sourceKey: "code:r:a.ts", targetKey: "code:r:b.ts", type: "IMPORTS" }],
      },
      CTX,
    );

    // IMPORTS passes the guard → edge MERGE is issued (3rd call)
    expect(mocks.run).toHaveBeenCalledTimes(3);
    // count from mock is 0
    expect(result.edgesUpserted).toBe(0);
  });

  it("truly invalid edge types are skipped and do not cause an error", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce({ records: [] });
    // Override: the contract validator already catches lowercase types, but
    // test the handler guard directly by injecting via casting.
    const badEdge = { sourceKey: "code:r:a.ts", targetKey: "code:r:b.ts", type: "invalid type!" };
    // We have to cast past the contract validator to test the handler guard
    const input = {
      ...BASE_INPUT,
      nodes: [{ key: "code:r:a.ts", labels: ["SourceFile"], displayName: "a.ts", properties: {}, isSystem: true }],
      edges: [badEdge as unknown as { sourceKey: string; targetKey: string; type: string }],
    };
    const result = await graphSyncPushHandler(input as Parameters<typeof graphSyncPushHandler>[0], CTX);
    // Handler skips the bad edge silently, count remains 0
    expect(result.edgesUpserted).toBe(0);
    // Only 2 calls: node MERGE + label SET; no edge MERGE
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("tombstones DETACH DELETE nodes by key and returns the count", async () => {
    mocks.run.mockResolvedValueOnce(tombResult(2));

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        tombstones: [{ key: "code:r:old.ts" }, { key: "code:r:deleted.ts" }],
      },
      CTX,
    );

    expect(result.tombstoned).toBe(2);
    const tombCypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(tombCypher).toContain("DETACH DELETE n");
    expect(tombCypher).toContain("n.orgId = $orgId");
    expect(tombCypher).toContain("n.workspaceId = $workspaceId");
  });

  it("tombstone naturalKeys are prefixed with sync:{source}:", async () => {
    mocks.run.mockResolvedValueOnce(tombResult(1));

    await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        tombstones: [{ key: "code:r:gone.ts" }],
      },
      CTX,
    );

    const params = mocks.run.mock.calls[0]?.[1] as { keys: string[] };
    expect(params.keys).toEqual(["sync:code:code:r:gone.ts"]);
  });

  it("closes the session even when a node MERGE query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j offline"));
    await expect(
      graphSyncPushHandler(
        {
          ...BASE_INPUT,
          nodes: [{ key: "code:r:a.ts", labels: ["SourceFile"], displayName: "a.ts", properties: {}, isSystem: true }],
        },
        CTX,
      ),
    ).rejects.toThrow("Neo4j offline");
    expect(mocks.close).toHaveBeenCalled();
  });

  it("normalises {low, high} Neo4j integer format for node count", async () => {
    mocks.run
      .mockResolvedValueOnce({ records: [{ get: () => ({ low: 7, high: 0 }) }] })
      .mockResolvedValue({ records: [] });

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [{ key: "k", labels: ["SourceFile"], displayName: "k", properties: {}, isSystem: true }],
      },
      CTX,
    );
    expect(result.nodesUpserted).toBe(7);
  });

  it("is idempotent — re-sending the same payload does not reject", async () => {
    // Both calls should succeed (MERGE is inherently idempotent)
    mocks.run.mockResolvedValue(countResult(1));

    // `isSystem: true as const` preserves the literal type required by the handler.
    const payload = {
      ...BASE_INPUT,
      nodes: [
        {
          key: "code:r:a.ts",
          labels: ["SourceFile"],
          displayName: "a.ts",
          properties: {} as Record<string, unknown>,
          isSystem: true as const,
        },
      ],
    };

    const r1 = await graphSyncPushHandler(payload, CTX);
    mocks.run.mockResolvedValue(countResult(1));
    const r2 = await graphSyncPushHandler(payload, CTX);

    expect(r1.nodesUpserted).toBe(1);
    expect(r2.nodesUpserted).toBe(1);
  });

  it("stores a valid 1536-d embedding — Cypher SETs node.embedding, params carry the vector", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1)) // node MERGE
      .mockResolvedValue({ records: [] }); // domain label SET

    const vec = Array.from({ length: 1536 }, () => 0.01);
    await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          {
            key: "code:r:a.ts",
            labels: ["SourceFile"],
            displayName: "a.ts",
            properties: {},
            isSystem: true,
            embedding: vec,
          },
        ],
      },
      CTX,
    );

    // The node MERGE Cypher writes the embedding + timestamp.
    const mergeCypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(mergeCypher).toContain("node.embedding = coalesce(n.embedding, node.embedding)");
    expect(mergeCypher).toContain("node.embeddingUpdatedAt");
    // The vector is carried through as a param on the unwound node.
    const params = mocks.run.mock.calls[0]?.[1] as {
      nodes: Array<{ embedding: number[] | null }>;
    };
    expect(params.nodes[0]?.embedding).toHaveLength(1536);
    expect(params.nodes[0]?.embedding?.[0]).toBe(0.01);
  });

  it("ignores an embedding with the wrong dimension (dropped to null param)", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValue({ records: [] });

    await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          {
            key: "code:r:a.ts",
            labels: ["SourceFile"],
            displayName: "a.ts",
            properties: {},
            isSystem: true,
            embedding: [0.1, 0.2, 0.3], // 3-d — not 1536-d
          },
        ],
      },
      CTX,
    );

    const params = mocks.run.mock.calls[0]?.[1] as {
      nodes: Array<{ embedding: number[] | null }>;
    };
    // Invalid dimension → dropped to null so coalesce keeps the existing vector.
    expect(params.nodes[0]?.embedding).toBeNull();
  });

  it("drops an absent embedding to null (non-fatal, node still upserted)", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValue({ records: [] });

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          {
            key: "code:r:a.ts",
            labels: ["SourceFile"],
            displayName: "a.ts",
            properties: {},
            isSystem: true,
          },
        ],
      },
      CTX,
    );

    expect(result.nodesUpserted).toBe(1);
    const params = mocks.run.mock.calls[0]?.[1] as {
      nodes: Array<{ embedding: number[] | null }>;
    };
    expect(params.nodes[0]?.embedding).toBeNull();
  });

  it("groups edges by type and emits one MERGE query per distinct type", async () => {
    mocks.run
      // node MERGE (2 nodes)
      .mockResolvedValueOnce(countResult(2))
      // label SET for SourceFile
      .mockResolvedValueOnce({ records: [] })
      // edge MERGE IMPORTS
      .mockResolvedValueOnce(countResult(1))
      // edge MERGE CONTAINS
      .mockResolvedValueOnce(countResult(1));

    const result = await graphSyncPushHandler(
      {
        ...BASE_INPUT,
        nodes: [
          { key: "code:r:a.ts", labels: ["SourceFile"], displayName: "a.ts", properties: {}, isSystem: true },
          { key: "code:r:b.ts", labels: ["SourceFile"], displayName: "b.ts", properties: {}, isSystem: true },
        ],
        edges: [
          { sourceKey: "code:r:a.ts", targetKey: "code:r:b.ts", type: "IMPORTS" },
          { sourceKey: "code:r:a.ts", targetKey: "code:r:b.ts", type: "CONTAINS" },
        ],
      },
      CTX,
    );

    expect(result.edgesUpserted).toBe(2);
    // 4 total calls: node MERGE + label SET + IMPORTS MERGE + CONTAINS MERGE
    expect(mocks.run).toHaveBeenCalledTimes(4);
  });
});
