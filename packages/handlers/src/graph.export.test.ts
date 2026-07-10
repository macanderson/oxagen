/**
 * graph.export handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required. The
 * handler runs up to three queries per call (count, page, edges). Verify:
 *   - Both node queries scope by orgId AND workspaceId
 *   - Edge query scopes both endpoints by orgId AND workspaceId
 *   - Empty graph → empty nodes/edges, total 0, hasMore false, cursor null
 *   - Populated page maps rows into the contract shape (labels, decoded
 *     properties, isSystem, optional sourceId/updatedAt)
 *   - hasMore reflects offset + page length vs. total
 *   - Filters (labels / isSystem / updatedAfter) append clauses and pass params
 *   - cursor = max updatedAt among returned nodes (null when all lack it)
 *   - includeEdges=false skips the edge query entirely
 *   - Edge query is skipped when the node page is empty
 *   - Session is closed even when a query throws
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

import { graphExportHandler } from "./graph.export";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function countResult(total: number) {
  return { records: [{ get: (k: string) => (k === "total" ? total : null) }] };
}

function pageResult(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

beforeEach(() => {
  mocks.run.mockReset();
  mocks.close.mockReset();
  mocks.close.mockResolvedValue(undefined);
});

describe("graphExportHandler", () => {
  it("returns empty result for an empty graph", async () => {
    // count + page; edge query is skipped because the node page is empty
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );
    expect(result).toEqual({
      nodes: [],
      edges: [],
      total: 0,
      hasMore: false,
      limit: 500,
      offset: 0,
      cursor: null,
    });
  });

  it("maps a populated node page into the contract shape", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "pub-1",
            label: "Feature",
            displayName: "Dark mode",
            properties: JSON.stringify({ priority: "high" }),
            sourceId: "intg_linear",
            isSystem: false,
            updatedAt: "2026-06-01T10:00:00Z",
          },
        ]),
      )
      // edges query returns nothing
      .mockResolvedValueOnce(pageResult([]));

    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );

    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.nodes).toEqual([
      {
        id: "pub-1",
        labels: ["KnowledgeNode", "Feature"],
        displayName: "Dark mode",
        properties: { priority: "high" },
        sourceId: "intg_linear",
        isSystem: false,
        updatedAt: "2026-06-01T10:00:00Z",
      },
    ]);
    expect(result.cursor).toBe("2026-06-01T10:00:00Z");
  });

  it("omits optional fields when absent and defaults properties to {}", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "pub-2",
            label: "Topic",
            displayName: "Graph",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce(pageResult([]));

    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );
    const node = result.nodes[0];
    expect(node).toBeDefined();
    expect(node?.properties).toEqual({});
    expect(node?.isSystem).toBe(false);
    expect(node).not.toHaveProperty("sourceId");
    expect(node).not.toHaveProperty("updatedAt");
    expect(result.cursor).toBeNull();
  });

  it("does not let one row with a malformed properties blob kill the export", async () => {
    // Regression: an unguarded JSON.parse per row rejected the entire export
    // on the first corrupt node/edge blob.
    mocks.run
      .mockResolvedValueOnce(countResult(2))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "good",
            label: "Issue",
            displayName: "A",
            properties: JSON.stringify({ ok: true }),
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
          {
            id: "bad",
            label: "Issue",
            displayName: "B",
            properties: "{corrupt",
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "edge-bad",
            sourceId: "good",
            targetId: "bad",
            type: "RELATES_TO",
            properties: "{also corrupt",
            inferred: false,
          },
        ]),
      );

    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.properties).toEqual({ ok: true });
    expect(result.nodes[1]?.properties).toEqual({});
    expect(result.edges[0]?.properties).toEqual({});
  });

  it("maps edges into the contract shape", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "pub-a",
            label: "Feature",
            displayName: "A",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: "2026-06-01T10:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "edge-1",
            sourceId: "pub-a",
            targetId: "pub-b",
            type: "RELATES_TO",
            properties: JSON.stringify({ weight: 0.9 }),
            inferred: true,
          },
        ]),
      );

    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );
    expect(result.edges).toEqual([
      {
        id: "edge-1",
        sourceId: "pub-a",
        targetId: "pub-b",
        type: "RELATES_TO",
        properties: { weight: 0.9 },
        inferred: true,
      },
    ]);
  });

  it("skips the edge query when includeEdges=false", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "pub-x",
            label: "Issue",
            displayName: "Bug",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
        ]),
      );

    const result = await graphExportHandler(
      { includeEdges: false, limit: 500, offset: 0 },
      CTX,
    );
    // Only 2 queries issued (count + page), no third edge query
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(result.edges).toEqual([]);
  });

  it("computes hasMore from offset + page length vs total", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(100))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "a",
            label: "X",
            displayName: "A",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
          {
            id: "b",
            label: "X",
            displayName: "B",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce(pageResult([]));
    const result = await graphExportHandler(
      { includeEdges: true, limit: 2, offset: 0 },
      CTX,
    );
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
  });

  it("scopes node queries by orgId AND workspaceId (tenant-isolation guard)", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    await graphExportHandler({ includeEdges: true, limit: 500, offset: 0 }, CTX);
    for (const call of mocks.run.mock.calls) {
      const cypher = call[0] as string;
      expect(cypher).toContain("n.orgId = $orgId");
      expect(cypher).toContain("n.workspaceId = $workspaceId");
    }
  });

  it("scopes edge query on both endpoints by orgId AND workspaceId", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "p1",
            label: "X",
            displayName: "X",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce(pageResult([]));
    await graphExportHandler({ includeEdges: true, limit: 500, offset: 0 }, CTX);
    const edgeCypher = mocks.run.mock.calls[2]?.[0] as string;
    expect(edgeCypher).toBeDefined();
    expect(edgeCypher).toContain("a.orgId = $orgId");
    expect(edgeCypher).toContain("a.workspaceId = $workspaceId");
    expect(edgeCypher).toContain("b.orgId = $orgId");
    expect(edgeCypher).toContain("b.workspaceId = $workspaceId");
  });

  it("passes pageIds to the edge query to restrict to the current node page", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "pub-page-1",
            label: "Feature",
            displayName: "F",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce(pageResult([]));
    await graphExportHandler({ includeEdges: true, limit: 500, offset: 0 }, CTX);
    const edgeParams = mocks.run.mock.calls[2]?.[1] as Record<string, unknown>;
    expect(edgeParams?.pageIds).toEqual(["pub-page-1"]);
  });

  it("appends label, isSystem and updatedAfter filters and passes params", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    await graphExportHandler(
      {
        includeEdges: true,
        limit: 10,
        offset: 5,
        labels: ["Issue"],
        isSystem: false,
        updatedAfter: "2026-01-01T00:00:00Z",
      },
      CTX,
    );
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(cypher).toContain("n.label IN $labels");
    expect(cypher).toContain("coalesce(n.is_system, false) = false");
    expect(cypher).toContain("n.updatedAt > $updatedAfter");
    expect(params.labels).toEqual(["Issue"]);
    expect(params.updatedAfter).toBe("2026-01-01T00:00:00Z");
    // Bolt requires INTEGER for SKIP/LIMIT, so the handler wraps these in
    // BigInt — a plain JS number serialises as Float and Neo4j rejects it.
    expect(params.offset).toBe(BigInt(5));
    expect(params.limit).toBe(BigInt(10));
  });

  it("omits optional filter clauses when not supplied", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    await graphExportHandler({ includeEdges: true, limit: 500, offset: 0 }, CTX);
    // Check the count query (call[0]) — same WHERE clause as the page query
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).not.toContain("n.label IN $labels");
    expect(cypher).not.toContain("n.updatedAt > $updatedAfter");
    // is_system filter is not added when isSystem is undefined; the RETURN
    // projection of the page query contains coalesce(n.is_system,...) but
    // the count query (call[0]) does not.
    expect(cypher).not.toContain("coalesce(n.is_system");
  });

  it("cursor is the max updatedAt among returned nodes", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(3))
      .mockResolvedValueOnce(
        pageResult([
          {
            id: "n1",
            label: "X",
            displayName: "A",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: "2026-05-01T00:00:00Z",
          },
          {
            id: "n2",
            label: "X",
            displayName: "B",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: null,
          },
          {
            id: "n3",
            label: "X",
            displayName: "C",
            properties: null,
            sourceId: null,
            isSystem: false,
            updatedAt: "2026-06-15T12:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(pageResult([]));

    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );
    expect(result.cursor).toBe("2026-06-15T12:00:00Z");
  });

  it("normalises a {low,high} integer count from the driver", async () => {
    mocks.run
      .mockResolvedValueOnce({
        records: [{ get: () => ({ low: 42, high: 0 }) }],
      })
      .mockResolvedValueOnce(pageResult([]));
    const result = await graphExportHandler(
      { includeEdges: true, limit: 500, offset: 0 },
      CTX,
    );
    expect(result.total).toBe(42);
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphExportHandler({ includeEdges: true, limit: 500, offset: 0 }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
