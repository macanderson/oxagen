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
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result).toEqual({
      nodes: [],
      total: 0,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
  });

  it("runs count then page sequentially on one session — never concurrently (Neo4j 'open transaction')", async () => {
    // Neo4j allows only one in-flight query per session; reject overlap with the
    // real driver error. Sequential passes, but a Promise.all() over the shared
    // session fires the second run() while the first is still awaiting and
    // throws.
    let inFlight = 0;
    mocks.run.mockImplementation(async () => {
      if (inFlight > 0) {
        throw new Error(
          "Queries cannot be run directly on a session with an open transaction; either run from within the transaction or use a different session.",
        );
      }
      inFlight += 1;
      await Promise.resolve();
      inFlight -= 1;
      return { records: [] };
    });

    await expect(
      graphNodeListHandler({ limit: 50, offset: 0 }, CTX),
    ).resolves.toBeDefined();
    expect(mocks.run).toHaveBeenCalledTimes(2);
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
        {
          id: "n-2",
          label: "Topic",
          displayName: "Neo4j",
          properties: null,
          sourceId: null,
          createdAt: null,
        },
      ]),
    );

    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    const node = result.nodes[0];
    expect(node).toBeDefined();
    expect(node?.properties).toEqual({});
    expect(node).not.toHaveProperty("sourceId");
    expect(node).not.toHaveProperty("createdAt");
  });

  it("does not let one row with a malformed properties blob kill the whole list", async () => {
    // Regression: an unguarded JSON.parse per row rejected the entire handler
    // on the first corrupt node — a single bad blob blanked the graph
    // explorer's initial load ("Couldn't load the graph").
    mocks.run.mockResolvedValueOnce(countResult(3)).mockResolvedValueOnce(
      pageResult([
        {
          id: "good-1",
          label: "Issue",
          displayName: "A",
          properties: JSON.stringify({ ok: true }),
          sourceId: null,
          createdAt: null,
        },
        {
          id: "bad",
          label: "Issue",
          displayName: "B",
          properties: "{corrupt",
          sourceId: null,
          createdAt: null,
        },
        {
          id: "good-2",
          label: "Topic",
          displayName: "C",
          properties: JSON.stringify({ n: 1 }),
          sourceId: null,
          createdAt: null,
        },
      ]),
    );

    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.map((n) => n.id)).toEqual(["good-1", "bad", "good-2"]);
    expect(result.nodes[0]?.properties).toEqual({ ok: true });
    expect(result.nodes[1]?.properties).toEqual({});
    expect(result.nodes[2]?.properties).toEqual({ n: 1 });
  });

  it("passes native driver map properties through without JSON.parse", async () => {
    mocks.run.mockResolvedValueOnce(countResult(1)).mockResolvedValueOnce(
      pageResult([
        {
          id: "n-native",
          label: "Topic",
          displayName: "Native map",
          properties: { status: "open", nested: { deep: true } },
          sourceId: null,
          createdAt: null,
        },
      ]),
    );

    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result.nodes[0]?.properties).toEqual({
      status: "open",
      nested: { deep: true },
    });
  });

  it("computes hasMore from offset + page length vs total", async () => {
    mocks.run.mockResolvedValueOnce(countResult(100)).mockResolvedValueOnce(
      pageResult([
        {
          id: "a",
          label: "X",
          displayName: "A",
          properties: null,
          sourceId: null,
          createdAt: null,
        },
        {
          id: "b",
          label: "X",
          displayName: "B",
          properties: null,
          sourceId: null,
          createdAt: null,
        },
      ]),
    );
    const result = await graphNodeListHandler({ limit: 2, offset: 0 }, CTX);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
  });

  it("normalises a {low,high} integer count from the driver", async () => {
    mocks.run
      .mockResolvedValueOnce({
        records: [{ get: () => ({ low: 7, high: 0 }) }],
      })
      .mockResolvedValueOnce(pageResult([]));
    const result = await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result.total).toBe(7);
  });

  it("scopes both queries by orgId AND workspaceId (tenant-isolation guard)", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    for (const call of mocks.run.mock.calls) {
      const cypher = call[0] as string;
      expect(cypher).toContain("n.orgId = $orgId");
      expect(cypher).toContain("n.workspaceId = $workspaceId");
    }
  });

  it("appends label, source and text filters and passes parameters", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    await graphNodeListHandler(
      {
        limit: 25,
        offset: 10,
        labels: ["Issue"],
        sourceId: "intg_jira",
        query: "auth",
      },
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
    // Bolt requires INTEGER for SKIP/LIMIT, so the handler wraps these in
    // BigInt — a plain JS number serialises as Float and Neo4j rejects it.
    expect(params.offset).toBe(BigInt(10));
    expect(params.limit).toBe(BigInt(25));
  });

  it("omits optional filter clauses when not supplied", async () => {
    mocks.run
      .mockResolvedValueOnce(countResult(0))
      .mockResolvedValueOnce(pageResult([]));
    await graphNodeListHandler({ limit: 50, offset: 0 }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).not.toContain("n.label IN $labels");
    expect(cypher).not.toContain("n.sourceId = $sourceId");
    expect(cypher).not.toContain("CONTAINS toLower($query)");
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphNodeListHandler({ limit: 50, offset: 0 }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
