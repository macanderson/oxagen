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
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

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
      { fromNodeId: "start-1", toNodeId: "n-2", edgeType: "RELATED_TO" },
    ]);
  });

  it("builds the relationship pattern from allow-listed edge types only", async () => {
    mocks.run.mockResolvedValueOnce(makeRows([START_ROW])).mockResolvedValueOnce(makeRows([]));
    await ontologyQueryHandler(
      { startNodeId: "start-1", edgeTypes: ["DEPENDS_ON"], direction: "out", maxDepth: 3, limit: 50 },
      CTX,
    );
    const traversalCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(traversalCypher).toContain("DEPENDS_ON");
    expect(traversalCypher).toContain("*1..3");
  });

  it("flags truncation when more nodes are reachable than the limit", async () => {
    mocks.run.mockResolvedValueOnce(makeRows([START_ROW])).mockResolvedValueOnce(
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
