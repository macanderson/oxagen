/**
 * ontology.neighbors handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - The existence + neighbor queries scope by BOTH orgId AND workspaceId
 *   - A missing node reports found:false with no neighbors and no traversal query
 *   - Neighbors are mapped into the contract shape with edge type + direction
 *   - The direction filter clause is applied for 'out' / 'in' and omitted for 'both'
 *   - Truncation is flagged when more neighbors exist than `limit`
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

import { ontologyNeighborsHandler } from "./ontology.neighbors";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

const EXISTS = makeRows([{ nodeId: "n-1" }]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeRows([]));
});

describe("ontologyNeighborsHandler", () => {
  it("reports found:false and runs no traversal when the node is missing", async () => {
    mocks.run.mockResolvedValueOnce(makeRows([])); // existence: not found
    const result = await ontologyNeighborsHandler(
      { nodeId: "missing", direction: "both", limit: 100 },
      CTX,
    );
    expect(result.found).toBe(false);
    expect(result.neighbors).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("scopes both queries by orgId and workspaceId (tenant-isolation guard)", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler({ nodeId: "n-1", direction: "both", limit: 100 }, CTX);
    const existsCypher = mocks.run.mock.calls[0]?.[0] as string;
    const neighborCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(existsCypher).toContain("orgId: $orgId");
    expect(existsCypher).toContain("workspaceId: $workspaceId");
    expect(neighborCypher).toContain("m.orgId = $orgId");
    expect(neighborCypher).toContain("m.workspaceId = $workspaceId");
  });

  it("maps neighbors into the contract shape with edge type and direction", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-2",
          label: "Topic",
          displayName: "Auth",
          description: "area",
          edgeType: "RELATED_TO",
          direction: "out",
        },
      ]),
    );
    const result = await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    expect(result.found).toBe(true);
    expect(result.neighbors).toEqual([
      {
        nodeId: "n-2",
        label: "Topic",
        displayName: "Auth",
        description: "area",
        edgeType: "RELATED_TO",
        direction: "out",
      },
    ]);
  });

  it("applies the direction filter for 'out' and omits it for 'both'", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler({ nodeId: "n-1", direction: "out", limit: 10 }, CTX);
    expect(mocks.run.mock.calls[1]?.[0]).toContain("startNode(r) = n");

    vi.clearAllMocks();
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler({ nodeId: "n-1", direction: "both", limit: 10 }, CTX);
    const bothCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(bothCypher).not.toContain("startNode(r) = n\n");
  });

  it("flags truncation when more neighbors exist than the limit", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-2",
          label: "T",
          displayName: "A",
          description: null,
          edgeType: "RELATED_TO",
          direction: "out",
        },
        {
          nodeId: "n-3",
          label: "T",
          displayName: "B",
          description: null,
          edgeType: "RELATED_TO",
          direction: "in",
        },
      ]),
    );
    const result = await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 1 },
      CTX,
    );
    expect(result.neighbors).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      ontologyNeighborsHandler({ nodeId: "n-1", direction: "both", limit: 100 }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
