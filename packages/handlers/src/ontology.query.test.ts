/**
 * ontology.query handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - The start-node lookup scopes by BOTH orgId AND workspaceId
 *   - An unknown start node yields an empty, non-error result
 *   - Reachable nodes + reconstructed edges are mapped into the contract shape
 *   - The relationship-type pattern only contains allow-listed edge types
 *   - Truncation is flagged when more nodes are reachable than `limit`
 *   - The session is closed even when a query throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  getPinnedSchema: vi.fn(async (..._a: unknown[]) => null as unknown),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

// The §3.2 guard resolves the pinned active vocabulary via getPinnedSchema.
vi.mock("./schema.pinned", () => ({
  getPinnedSchema: (...a: unknown[]) => mocks.getPinnedSchema(...a),
}));

function pinnedWith(relTypes: string[]): unknown {
  return {
    registryId: "scr_1",
    versionId: "scv_1",
    versionNumber: 1,
    enforcementMode: "lenient",
    conformanceFloor: 0.5,
    labels: [],
    relationshipTypes: relTypes.map((name) => ({
      schemaName: "s",
      name,
      displayName: name,
      description: null,
      startLabel: null,
      endLabel: null,
      cardinality: null,
      properties: [],
    })),
  };
}

import { ontologyQueryHandler } from "./ontology.query";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

const START_ROW = {
  nodeId: "start-1",
  label: "Issue",
  displayName: "Root issue",
  description: "the seed",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeRows([]));
  mocks.getPinnedSchema.mockResolvedValue(null);
});

describe("ontologyQueryHandler", () => {
  it("scopes the start-node lookup by BOTH orgId and workspaceId (tenant-isolation guard)", async () => {
    await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain("orgId: $orgId");
    expect(cypher).toContain("workspaceId: $workspaceId");
  });

  it("returns an empty result when the start node does not exist", async () => {
    mocks.run.mockResolvedValueOnce(makeRows([])); // start lookup: not found
    const result = await ontologyQueryHandler(
      { startNodeId: "missing", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );
    expect(result.startNode).toBeNull();
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(false);
    // Only the start-node lookup ran; no traversal query when start is missing.
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("maps reachable nodes and reconstructs edges along the path", async () => {
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(
        makeRows([
          {
            nodeId: "n-2",
            label: "Topic",
            displayName: "Auth",
            description: null,
            depth: 1,
            relTypes: ["RELATED_TO"],
            pathNodeIds: ["start-1", "n-2"],
          },
        ]),
      );

    const result = await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );

    expect(result.startNode).toEqual({
      nodeId: "start-1",
      label: "Issue",
      displayName: "Root issue",
      description: "the seed",
      depth: 0,
    });
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.nodeId)).toEqual(["start-1", "n-2"]);
    expect(result.edges).toEqual([
      {
        fromNodeId: "start-1",
        toNodeId: "n-2",
        edgeType: "RELATED_TO",
        // Unstamped edge (mock omits validity columns) → all-null validity.
        validFrom: null,
        validTo: null,
        recordedAt: null,
        invalidatedAt: null,
      },
    ]);
  });

  it("builds the relationship pattern from allow-listed edge types only", async () => {
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      {
        startNodeId: "start-1",
        edgeTypes: ["DEPENDS_ON"],
        direction: "out",
        maxDepth: 3,
        limit: 50,
      },
      CTX,
    );
    const traversalCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(traversalCypher).toContain("DEPENDS_ON");
    expect(traversalCypher).toContain("*1..3");
  });

  it("flags truncation when more nodes are reachable than the limit", async () => {
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(
        makeRows([
          {
            nodeId: "n-2",
            label: "Topic",
            displayName: "A",
            description: null,
            depth: 1,
            relTypes: ["RELATED_TO"],
            pathNodeIds: ["start-1", "n-2"],
          },
          {
            nodeId: "n-3",
            label: "Topic",
            displayName: "B",
            description: null,
            depth: 1,
            relTypes: ["RELATED_TO"],
            pathNodeIds: ["start-1", "n-3"],
          },
        ]),
      );

    const result = await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 1, limit: 1 },
      CTX,
    );
    // start (depth 0) + 1 reachable node kept; the second is dropped → truncated.
    expect(result.truncated).toBe(true);
    expect(result.nodes.map((n) => n.nodeId)).toEqual(["start-1", "n-2"]);
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      ontologyQueryHandler(
        { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
        CTX,
      ),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});

describe("ontologyQueryHandler — §3.2 Cypher-injection + active-vocabulary guard", () => {
  it("rejects an injection-shaped relationship type before any Cypher runs", async () => {
    // ontology.query INTERPOLATES the relationship type into the variable-length
    // pattern, so the lexical guard here is load-bearing for injection safety.
    await expect(
      ontologyQueryHandler(
        {
          startNodeId: "start-1",
          edgeTypes: ["`]->()-[:x"],
          direction: "out",
          maxDepth: 2,
          limit: 100,
        },
        CTX,
      ),
    ).rejects.toThrow(/lexical guard/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects a relationship type absent from the pinned active vocabulary", async () => {
    mocks.getPinnedSchema.mockResolvedValue(pinnedWith(["EMPLOYS"]));
    await expect(
      ontologyQueryHandler(
        {
          startNodeId: "start-1",
          edgeTypes: ["KNOWS"],
          direction: "out",
          maxDepth: 2,
          limit: 100,
        },
        CTX,
      ),
    ).rejects.toThrow(/active vocabulary/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("interpolates ONLY guard-passing, active-vocabulary types into the pattern", async () => {
    mocks.getPinnedSchema.mockResolvedValue(pinnedWith(["EMPLOYS"]));
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      {
        startNodeId: "start-1",
        edgeTypes: ["EMPLOYS"],
        direction: "out",
        maxDepth: 3,
        limit: 50,
      },
      CTX,
    );
    const traversalCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(traversalCypher).toContain("`EMPLOYS`");
    expect(traversalCypher).toContain("*1..3");
  });

  it("defaults the omitted filter to the pinned active vocabulary, not a static list", async () => {
    mocks.getPinnedSchema.mockResolvedValue(
      pinnedWith(["EMPLOYS", "SIGNED_CONTRACT"]),
    );
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );
    const traversalCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(traversalCypher).toContain("`EMPLOYS`|`SIGNED_CONTRACT`");
  });

  it("traverses unconstrained ([r*1..n], no type selector) when nothing pinned and no filter", async () => {
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );
    const traversalCypher = mocks.run.mock.calls[1]?.[0] as string;
    // No relationship-type selector — the pattern is `[r*1..2]`.
    expect(traversalCypher).toContain("[r*1..2]");
  });
});

// ── bi-temporal time-aware traversal ──────────────────────────────────────────

describe("ontologyQueryHandler — asOf / asKnownAt validity filter", () => {
  it("filters every relationship on the path by validity and projects per-edge validity", async () => {
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );
    const cypher = mocks.run.mock.calls[1]?.[0] as string;
    // Applied per-relationship across the whole path.
    expect(cypher).toContain("ALL(rel IN relationships(path) WHERE");
    expect(cypher).toContain(
      "rel.validFrom IS NULL OR rel.validFrom <= datetime($asOf)",
    );
    expect(cypher).toContain(
      "rel.invalidatedAt IS NULL OR rel.invalidatedAt > datetime($asKnownAt)",
    );
    // Per-edge validity arrays projected for citation.
    expect(cypher).toContain("[rel IN rels | toString(rel.validFrom)]");
  });

  it("defaults asOf / asKnownAt to ~now when omitted (behaviour-preserving)", async () => {
    const before = Date.now();
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      { startNodeId: "start-1", direction: "out", maxDepth: 2, limit: 100 },
      CTX,
    );
    const params = mocks.run.mock.calls[1]?.[1] as Record<string, string>;
    expect(new Date(String(params.asOf)).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(new Date(String(params.asKnownAt)).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it("threads explicit asOf / asKnownAt through as params and carries per-edge validity to output", async () => {
    mocks.run
      .mockResolvedValueOnce(makeRows([START_ROW]))
      .mockResolvedValueOnce(
        makeRows([
          {
            nodeId: "n-2",
            label: "Topic",
            displayName: "Auth",
            description: null,
            depth: 1,
            relTypes: ["RELATED_TO"],
            relValidFrom: ["2020-01-01T00:00:00.000Z"],
            relValidTo: [null],
            relRecordedAt: ["2020-01-02T00:00:00.000Z"],
            relInvalidatedAt: [null],
            pathNodeIds: ["start-1", "n-2"],
          },
        ]),
      );
    const result = await ontologyQueryHandler(
      {
        startNodeId: "start-1",
        direction: "out",
        maxDepth: 2,
        limit: 100,
        asOf: "2020-06-01T00:00:00.000Z",
        asKnownAt: "2020-06-01T00:00:00.000Z",
      },
      CTX,
    );
    const params = mocks.run.mock.calls[1]?.[1] as Record<string, string>;
    expect(params.asOf).toBe("2020-06-01T00:00:00.000Z");
    expect(params.asKnownAt).toBe("2020-06-01T00:00:00.000Z");
    expect(result.edges).toEqual([
      {
        fromNodeId: "start-1",
        toNodeId: "n-2",
        edgeType: "RELATED_TO",
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: null,
        recordedAt: "2020-01-02T00:00:00.000Z",
        invalidatedAt: null,
      },
    ]);
  });
});
