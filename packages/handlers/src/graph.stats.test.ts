/**
 * graph.stats handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required. The
 * handler runs a fixed sequence of queries:
 *   1. node + source counts
 *   2. edge + inferred-edge counts
 *   3. lastModifiedAt
 *   4. (only when includeByType) nodes-by-label
 *   5. (only when includeByType) edges-by-type
 * The mock returns results in that order. Verify:
 *   - Empty graph → all zero counts, includeByType breakdowns absent
 *   - Populated counts map correctly (including {low,high} normalisation)
 *   - includeByType=true returns nodesByLabel and edgesByType maps
 *   - All queries scope by orgId AND workspaceId
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

import { graphStatsHandler } from "./graph.stats";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function record(fields: Record<string, unknown>) {
  return { records: [{ get: (k: string) => (k in fields ? fields[k] : null) }] };
}

function rows(list: Record<string, unknown>[]) {
  return { records: list.map((f) => ({ get: (k: string) => (k in f ? f[k] : null) })) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("graphStatsHandler", () => {
  it("returns zero counts for an empty graph", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    const result = await graphStatsHandler({ includeByType: false }, CTX);

    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);
    expect(result.inferredEdgeCount).toBe(0);
    expect(result.sourceCount).toBe(0);
    expect(result.nodesByLabel).toBeUndefined();
    expect(result.edgesByType).toBeUndefined();
    expect(typeof result.lastModifiedAt).toBe("string");
  });

  it("maps populated counts and lastModifiedAt", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 6200, sourceCount: 4 }))
      .mockResolvedValueOnce(record({ edgeCount: 18450, inferredEdgeCount: 3210 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: "2026-06-10T14:05:00Z" }));

    const result = await graphStatsHandler({ includeByType: false }, CTX);

    expect(result.nodeCount).toBe(6200);
    expect(result.sourceCount).toBe(4);
    expect(result.edgeCount).toBe(18450);
    expect(result.inferredEdgeCount).toBe(3210);
    expect(result.lastModifiedAt).toBe("2026-06-10T14:05:00Z");
  });

  it("normalises {low,high} integer counts from the driver", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: { low: 12, high: 0 }, sourceCount: { low: 2, high: 0 } }))
      .mockResolvedValueOnce(record({ edgeCount: { low: 30, high: 0 }, inferredEdgeCount: { low: 5, high: 0 } }))
      .mockResolvedValueOnce(record({ lastModifiedAt: "2026-01-01T00:00:00Z" }));

    const result = await graphStatsHandler({ includeByType: false }, CTX);
    expect(result.nodeCount).toBe(12);
    expect(result.sourceCount).toBe(2);
    expect(result.edgeCount).toBe(30);
    expect(result.inferredEdgeCount).toBe(5);
  });

  it("returns breakdowns when includeByType=true", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 3, sourceCount: 1 }))
      .mockResolvedValueOnce(record({ edgeCount: 2, inferredEdgeCount: 1 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: "2026-06-10T14:05:00Z" }))
      .mockResolvedValueOnce(
        rows([
          { label: "Issue", count: 2 },
          { label: "Topic", count: 1 },
        ]),
      )
      .mockResolvedValueOnce(rows([{ edgeType: "RELATED_TO", count: 2 }]));

    const result = await graphStatsHandler({ includeByType: true }, CTX);

    expect(result.nodesByLabel).toEqual({ Issue: 2, Topic: 1 });
    expect(result.edgesByType).toEqual({ RELATED_TO: 2 });
  });

  it("scopes every query by orgId AND workspaceId (tenant-isolation guard)", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    await graphStatsHandler({ includeByType: false }, CTX);

    for (const call of mocks.run.mock.calls) {
      const cypher = call[0] as string;
      expect(cypher).toContain("n.orgId = $orgId");
      expect(cypher).toContain("n.workspaceId = $workspaceId");
    }
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(graphStatsHandler({ includeByType: false }, CTX)).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });

  it("attaches a graph-stats render directive on the app (chat) surface", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 5, sourceCount: 1 }))
      .mockResolvedValueOnce(record({ edgeCount: 7, inferredEdgeCount: 2 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: "2026-06-10T14:05:00Z" }));

    const result = await graphStatsHandler(
      { includeByType: false },
      { ...CTX, surface: "app" },
    );

    expect(result.render).toEqual({
      componentId: "graph-stats",
      props: expect.objectContaining({
        nodeCount: 5,
        edgeCount: 7,
        inferredEdgeCount: 2,
        sourceCount: 1,
      }),
    });
  });

  it("runs its queries sequentially on one session — never concurrently (regression: #303 Neo4j 'open transaction')", async () => {
    // A real Neo4j session permits only ONE in-flight query (auto-commit
    // transaction) at a time. Model that exactly: if a second run() begins
    // before the previous one resolves, throw the real driver error. A
    // sequential handler never triggers it; a Promise.all() over the single
    // scoped session (the #303 regression that broke the graph explorer) does —
    // the second run() fires synchronously while the first is still awaiting.
    let inFlight = 0;
    mocks.run.mockImplementation(async () => {
      if (inFlight > 0) {
        throw new Error(
          "Queries cannot be run directly on a session with an open transaction; either run from within the transaction or use a different session.",
        );
      }
      inFlight += 1;
      await Promise.resolve(); // yield a microtask so an overlap would be observed
      inFlight -= 1;
      return record({
        nodeCount: 0,
        sourceCount: 0,
        edgeCount: 0,
        inferredEdgeCount: 0,
        lastModifiedAt: null,
        label: null,
        edgeType: null,
        count: 0,
      });
    });

    // includeByType=true exercises the maximum fan-out (five queries).
    await expect(
      graphStatsHandler({ includeByType: true }, CTX),
    ).resolves.toBeDefined();
    expect(mocks.run).toHaveBeenCalledTimes(5);
  });

  it("omits the render directive on non-app surfaces (api/mcp get plain JSON)", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    const result = await graphStatsHandler(
      { includeByType: false },
      { ...CTX, surface: "api" },
    );

    expect(result.render).toBeUndefined();
  });
});
