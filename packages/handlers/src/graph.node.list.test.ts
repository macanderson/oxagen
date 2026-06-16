/**
 * graph.node.list handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required. The
 * handler runs two queries per call (count, then page); the mock returns them
 * in order. Verify:
 *   - Both queries scope by orgId AND workspaceId
 *   - Empty graph → empty nodes, total 0, hasMore false
 *   - Populated page maps rows into the contract shape (labels array, decoded
 *     properties, optional sourceId/createdAt)
 *   - hasMore reflects offset + page vs. total
 *   - Filters (labels / sourceId / query) append clauses and pass parameters
 *   - Closes the session even when a query throws
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

import { graphNodeListHandler } from "./graph.node.list";
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

describe("graphNodeListHandler", () => {
  it("returns empty result for an empty graph", async () => {
    mocks.run.mockResolvedValueOnce(countResult(0)).mockResolvedValueOnce(pageResult([]));
    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result).toEqual({ nodes: [], total: 0, hasMore: false, limit: 50, offset: 0 });
  });

  it("maps a populated page into the contract shape", async () => {
    mocks.run.mockResolvedValueOnce(countResult(1)).mockResolvedValueOnce(
      pageResult([
        {
          id: "n-1",
          label: "Issue",
          displayName: "Fix auth",
          properties: JSON.stringify({ status: "open" }),
          sourceId: "intg_jira",
          createdAt: "2026-05-10T08:00:00Z",
        },
      ]),
    );

    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);

    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.nodes).toEqual([
      {
        id: "n-1",
        labels: ["KnowledgeNode", "Issue"],
        properties: { status: "open" },
        displayName: "Fix auth",
        sourceId: "intg_jira",
        createdAt: "2026-05-10T08:00:00Z",
      },
    ]);
  });

  it("omits sourceId/createdAt when absent and defaults properties to {}", async () => {
    mocks.run.mockResolvedValueOnce(countResult(1)).mockResolvedValueOnce(
      pageResult([
        { id: "n-2", label: "Topic", displayName: "Neo4j", properties: null, sourceId: null, createdAt: null },
      ]),
    );

    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    const node = result.nodes[0];
    expect(node).toBeDefined();
    expect(node?.properties).toEqual({});
    expect(node).not.toHaveProperty("sourceId");
    expect(node).not.toHaveProperty("createdAt");
  });

  it("computes hasMore from offset + page length vs total", async () => {
    mocks.run.mockResolvedValueOnce(countResult(100)).mockResolvedValueOnce(
      pageResult([
        { id: "a", label: "X", displayName: "A", properties: null, sourceId: null, createdAt: null },
        { id: "b", label: "X", displayName: "B", properties: null, sourceId: null, createdAt: null },
      ]),
    );
    const result = await graphNodeListHandler({ limit: 2, offset: 0 }, CTX);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
  });

  it("normalises a {low,high} integer count from the driver", async () => {
    mocks.run
      .mockResolvedValueOnce({ records: [{ get: () => ({ low: 7, high: 0 }) }] })
      .mockResolvedValueOnce(pageResult([]));
    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result.total).toBe(7);
  });

  it("scopes both queries by orgId AND workspaceId (tenant-isolation guard)", async () => {
    mocks.run.mockResolvedValueOnce(countResult(0)).mockResolvedValueOnce(pageResult([]));
    await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    for (const call of mocks.run.mock.calls) {
      const cypher = call[0] as string;
      expect(cypher).toContain("n.orgId = $orgId");
      expect(cypher).toContain("n.workspaceId = $workspaceId");
    }
  });

  it("appends label, source and text filters and passes parameters", async () => {
    mocks.run.mockResolvedValueOnce(countResult(0)).mockResolvedValueOnce(pageResult([]));
    await graphNodeListHandler(
      { limit: 25, offset: 10, labels: ["Issue"], sourceId: "intg_jira", query: "auth" },
      CTX,
    );
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(cypher).toContain("n.label IN $labels");
    expect(cypher).toContain("n.sourceId = $sourceId");
    expect(cypher).toContain("CONTAINS toLower($query)");
    expect(params.labels).toEqual(["Issue"]);
    expect(params.sourceId).toBe("intg_jira");
    expect(params.query).toBe("auth");
    expect(params.offset).toBe(10);
    expect(params.limit).toBe(25);
  });

  it("omits optional filter clauses when not supplied", async () => {
    mocks.run.mockResolvedValueOnce(countResult(0)).mockResolvedValueOnce(pageResult([]));
    await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).not.toContain("n.label IN $labels");
    expect(cypher).not.toContain("n.sourceId = $sourceId");
    expect(cypher).not.toContain("CONTAINS toLower($query)");
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(graphNodeListHandler({ limit: 50, offset: 0 }, CTX)).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
