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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { graphStats } from "@oxagen/oxagen/contracts/graph.stats";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function record(fields: Record<string, unknown>) {
  return {
    records: [{ get: (k: string) => (k in fields ? fields[k] : null) }],
  };
}

function rows(list: Record<string, unknown>[]) {
  return {
    records: list.map((f) => ({ get: (k: string) => (k in f ? f[k] : null) })),
  };
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

    const result = await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
      CTX,
    );

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
      .mockResolvedValueOnce(
        record({ edgeCount: 18450, inferredEdgeCount: 3210 }),
      )
      .mockResolvedValueOnce(
        record({ lastModifiedAt: "2026-06-10T14:05:00Z" }),
      );

    const result = await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
      CTX,
    );

    expect(result.nodeCount).toBe(6200);
    expect(result.sourceCount).toBe(4);
    expect(result.edgeCount).toBe(18450);
    expect(result.inferredEdgeCount).toBe(3210);
    expect(result.lastModifiedAt).toBe("2026-06-10T14:05:00Z");
  });

  it("normalises {low,high} integer counts from the driver", async () => {
    mocks.run
      .mockResolvedValueOnce(
        record({
          nodeCount: { low: 12, high: 0 },
          sourceCount: { low: 2, high: 0 },
        }),
      )
      .mockResolvedValueOnce(
        record({
          edgeCount: { low: 30, high: 0 },
          inferredEdgeCount: { low: 5, high: 0 },
        }),
      )
      .mockResolvedValueOnce(
        record({ lastModifiedAt: "2026-01-01T00:00:00Z" }),
      );

    const result = await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
      CTX,
    );
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

    const result = await graphStatsHandler(
      { includeByType: true, includeGrowth: false },
      CTX,
    );

    expect(result.nodesByLabel).toEqual({ Issue: 2, Topic: 1 });
    expect(result.edgesByType).toEqual({ RELATED_TO: 2 });
  });

  it("scopes every query by orgId AND workspaceId (tenant-isolation guard)", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
      CTX,
    );

    for (const call of mocks.run.mock.calls) {
      const cypher = call[0] as string;
      expect(cypher).toContain("n.orgId = $orgId");
      expect(cypher).toContain("n.workspaceId = $workspaceId");
    }
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphStatsHandler({ includeByType: false, includeGrowth: false }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });

  it("attaches a graph-stats render directive on the app (chat) surface", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 5, sourceCount: 1 }))
      .mockResolvedValueOnce(record({ edgeCount: 7, inferredEdgeCount: 2 }))
      .mockResolvedValueOnce(
        record({ lastModifiedAt: "2026-06-10T14:05:00Z" }),
      );

    const result = await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
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

  it("runs its queries sequentially on one session — never concurrently (Neo4j 'open transaction')", async () => {
    // A real Neo4j session permits only ONE in-flight query (auto-commit
    // transaction) at a time. Model that exactly: if a second run() begins
    // before the previous one resolves, throw the real driver error. A
    // sequential handler never triggers it; a Promise.all() over the single
    // scoped session does — the second run() fires synchronously while the
    // first is still awaiting.
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
      graphStatsHandler({ includeByType: true, includeGrowth: false }, CTX),
    ).resolves.toBeDefined();
    expect(mocks.run).toHaveBeenCalledTimes(5);
  });

  it("omits the render directive on non-app surfaces (api/mcp get plain JSON)", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    const result = await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
      { ...CTX, surface: "api" },
    );

    expect(result.render).toBeUndefined();
  });

  // ── growth block (includeGrowth) ────────────────────────────────────────────
  //
  // The growth query buckets by the UTC calendar day of GraphNode.createdAt (a
  // Neo4j temporal DateTime). The handler derives the today/yesterday/this-week/
  // last-week buckets and the 14-day daily series from `new Date()`, so we pin
  // the clock with fake timers to make the UTC day keys deterministic, then feed
  // the mocked growth query rows keyed on those same days.

  describe("includeGrowth", () => {
    // Fixed "now": 2026-06-14T12:00:00Z (a Sunday, mid-day UTC — safely away from
    // a day boundary so no rounding ambiguity).
    const NOW = new Date("2026-06-14T12:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // UTC day key (YYYY-MM-DD) offset from NOW by `dayOffset` days.
    function dayKey(dayOffset: number): string {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() + dayOffset);
      return d.toISOString().slice(0, 10);
    }

    it("computes the four buckets and a zero-filled 14-element daily series", async () => {
      // Base three queries, then the single growth query (no includeByType).
      mocks.run
        .mockResolvedValueOnce(record({ nodeCount: 100, sourceCount: 3 }))
        .mockResolvedValueOnce(record({ edgeCount: 50, inferredEdgeCount: 10 }))
        .mockResolvedValueOnce(
          record({ lastModifiedAt: "2026-06-14T09:00:00Z" }),
        )
        .mockResolvedValueOnce(
          rows([
            { day: dayKey(0), count: 5 }, // today
            { day: dayKey(-1), count: 3 }, // yesterday
            { day: dayKey(-3), count: 2 }, // this week
            { day: dayKey(-8), count: 7 }, // last week
            { day: dayKey(-13), count: 1 }, // oldest day in window
          ]),
        );

      const result = await graphStatsHandler(
        { includeByType: false, includeGrowth: true },
        CTX,
      );

      expect(result.growth).toBeDefined();
      const g = result.growth!;
      // today=5, yesterday=3
      expect(g.nodesToday).toBe(5);
      expect(g.nodesYesterday).toBe(3);
      // this week (offsets 0..-6) = today(5)+yesterday(3)+day-3(2) = 10
      expect(g.nodesThisWeek).toBe(10);
      // last week (offsets -7..-13) = day-8(7)+day-13(1) = 8
      expect(g.nodesLastWeek).toBe(8);

      // 14 ascending, zero-filled days; last element is today.
      expect(g.daily).toHaveLength(14);
      expect(g.daily[0]!.day).toBe(dayKey(-13));
      expect(g.daily[13]!.day).toBe(dayKey(0));
      expect(g.daily[13]!.count).toBe(5);
      expect(g.daily[0]!.count).toBe(1);
      // A day with no rows is zero-filled, not omitted.
      const emptyDay = g.daily.find((d) => d.day === dayKey(-2));
      expect(emptyDay).toBeDefined();
      expect(emptyDay!.count).toBe(0);
      // Ascending order.
      const days = g.daily.map((d) => d.day);
      expect([...days].sort()).toEqual(days);
    });

    it("runs exactly ONE extra query for growth and scopes it by createdAt window", async () => {
      mocks.run
        .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
        .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
        .mockResolvedValueOnce(record({ lastModifiedAt: null }))
        .mockResolvedValueOnce(rows([]));

      await graphStatsHandler(
        { includeByType: false, includeGrowth: true },
        CTX,
      );

      // 3 base + 1 growth = 4 queries total.
      expect(mocks.run).toHaveBeenCalledTimes(4);
      const growthCall = mocks.run.mock.calls[3]!;
      const cypher = growthCall[0] as string;
      expect(cypher).toContain("n.createdAt IS NOT NULL");
      expect(cypher).toContain("n.createdAt >= datetime($windowStart)");
      expect(cypher).toContain("date(n.createdAt)");
      const params = growthCall[1] as { windowStart: string };
      // Window start = start of the 14th-oldest UTC day (13 days before today).
      expect(params.windowStart).toBe("2026-06-01T00:00:00.000Z");
    });

    it("returns an all-zero growth block when no nodes fall in the window", async () => {
      mocks.run
        .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
        .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
        .mockResolvedValueOnce(record({ lastModifiedAt: null }))
        .mockResolvedValueOnce(rows([]));

      const result = await graphStatsHandler(
        { includeByType: false, includeGrowth: true },
        CTX,
      );

      const g = result.growth!;
      expect(g.nodesToday).toBe(0);
      expect(g.nodesYesterday).toBe(0);
      expect(g.nodesThisWeek).toBe(0);
      expect(g.nodesLastWeek).toBe(0);
      expect(g.daily).toHaveLength(14);
      expect(g.daily.every((d) => d.count === 0)).toBe(true);
    });

    it("runs the growth query AFTER the byType queries when both are requested", async () => {
      mocks.run
        .mockResolvedValueOnce(record({ nodeCount: 3, sourceCount: 1 }))
        .mockResolvedValueOnce(record({ edgeCount: 2, inferredEdgeCount: 1 }))
        .mockResolvedValueOnce(
          record({ lastModifiedAt: "2026-06-14T09:00:00Z" }),
        )
        .mockResolvedValueOnce(rows([{ label: "Issue", count: 3 }]))
        .mockResolvedValueOnce(rows([{ edgeType: "RELATED_TO", count: 2 }]))
        .mockResolvedValueOnce(rows([{ day: dayKey(0), count: 3 }]));

      const result = await graphStatsHandler(
        { includeByType: true, includeGrowth: true },
        CTX,
      );

      // 3 base + 2 byType + 1 growth = 6 queries.
      expect(mocks.run).toHaveBeenCalledTimes(6);
      expect(result.nodesByLabel).toEqual({ Issue: 3 });
      expect(result.edgesByType).toEqual({ RELATED_TO: 2 });
      expect(result.growth?.nodesToday).toBe(3);
      // The growth query is the LAST call.
      const lastCypher = mocks.run.mock.calls[5]![0] as string;
      expect(lastCypher).toContain("date(n.createdAt)");
    });
  });

  it("omits growth when includeGrowth is false and runs no extra query", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    const result = await graphStatsHandler(
      { includeByType: false, includeGrowth: false },
      CTX,
    );

    expect(result.growth).toBeUndefined();
    // Only the three base queries — no growth query.
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });

  it("omits growth when includeGrowth is omitted entirely (runtime default false)", async () => {
    mocks.run
      .mockResolvedValueOnce(record({ nodeCount: 0, sourceCount: 0 }))
      .mockResolvedValueOnce(record({ edgeCount: 0, inferredEdgeCount: 0 }))
      .mockResolvedValueOnce(record({ lastModifiedAt: null }));

    // Prove the runtime default: an input with includeGrowth omitted parses to
    // includeGrowth=false, so the handler runs no growth query and returns none.
    const parsed = graphStats.input.parse({ includeByType: false });
    expect(parsed.includeGrowth).toBe(false);

    const result = await graphStatsHandler(parsed, CTX);

    expect(result.growth).toBeUndefined();
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });
});
