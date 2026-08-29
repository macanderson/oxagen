/**
 * graph.search handler tests.
 *
 * Strategy: mock embedText and scopedSession() so no real Neo4j or AI gateway
 * call is required. Verify:
 *   - Calls embedText with executionStepId: null (billing correctness)
 *   - Cypher scopes by BOTH orgId AND workspaceId (tenant isolation)
 *   - Maps result rows into the contract output shape
 *   - Restricts generic search to customer-context entities
 *   - Builds snippet from properties.content, falling back to displayName
 *   - Closes the session even when run throws
 *   - BigInt-wraps the LIMIT for Neo4j
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  embedText: vi.fn(),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
}));

import { graphSearchHandler } from "./graph.search";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const VECTOR = new Array(1536).fill(0.1);

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.embedText.mockResolvedValue(VECTOR);
  mocks.run.mockResolvedValue(makeRows([]));
});

describe("graphSearchHandler", () => {
  it("calls embedText with executionStepId: null", async () => {
    await graphSearchHandler({ query: "find memory nodes", limit: 5 }, CTX);
    expect(mocks.embedText).toHaveBeenCalledTimes(1);
    const opts = mocks.embedText.mock.calls[0]![1] as {
      telemetry: { executionStepId: unknown };
    };
    expect(opts.telemetry.executionStepId).toBeNull();
  });

  it("passes the embedded vector as queryVector to Cypher", async () => {
    await graphSearchHandler({ query: "test", limit: 5 }, CTX);
    const params = mocks.run.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.queryVector).toEqual(VECTOR);
  });

  it("scopes Cypher by BOTH orgId AND workspaceId (tenant-isolation guard)", async () => {
    await graphSearchHandler({ query: "x", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).toContain("n.orgId = $orgId");
    expect(cypher).toContain("n.workspaceId = $workspaceId");
  });

  it("maps result rows into the contract output shape", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-1",
          label: "AgentMemory",
          displayName: "OAuth token expired",
          properties: null,
          score: 0.95,
        },
      ]),
    );

    const result = await graphSearchHandler({ query: "token", limit: 10 }, CTX);

    expect(result.results).toEqual([
      {
        nodeId: "n-1",
        label: "AgentMemory",
        displayName: "OAuth token expired",
        kind: "entity",
        snippet: "OAuth token expired",
        score: 0.95,
      },
    ]);
  });

  it("builds snippet from properties.content when present", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-content",
          label: "Document",
          displayName: "Authentication policy",
          properties: JSON.stringify({
            content: "Refresh tokens expire after 30 days.",
          }),
          score: 0.88,
        },
      ]),
    );
    const result = await graphSearchHandler(
      { query: "authenticate", limit: 5 },
      CTX,
    );
    expect(result.results[0]?.snippet).toBe(
      "Refresh tokens expire after 30 days.",
    );
  });

  it("falls back to displayName for snippet when properties has no content", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-fallback",
          label: "Person",
          displayName: "Alice Smith",
          properties: JSON.stringify({ age: 30 }),
          score: 0.85,
        },
      ]),
    );
    const result = await graphSearchHandler({ query: "alice", limit: 5 }, CTX);
    expect(result.results[0]?.snippet).toBe("Alice Smith");
  });

  it("returns empty array when nothing matches", async () => {
    const result = await graphSearchHandler({ query: "nope", limit: 10 }, CTX);
    expect(result.results).toEqual([]);
  });

  it("BigInt-wraps the limit so Neo4j receives INTEGER not Float", async () => {
    await graphSearchHandler({ query: "x", limit: 7 }, CTX);
    const params = mocks.run.mock.calls[0]![1] as Record<string, unknown>;
    expect(typeof params.limit).toBe("bigint");
    expect(typeof params.k).toBe("bigint");
  });

  it("over-fetches the index by 3x because tenant predicates post-filter", async () => {
    await graphSearchHandler({ query: "x", limit: 7 }, CTX);
    const params = mocks.run.mock.calls[0]![1] as Record<string, unknown>;
    // The tenant filter (orgId/workspaceId) is applied AFTER the index call on
    // every query, so k must over-sample.
    expect(params.k).toBe(BigInt(21)); // 7 x 3
  });

  it("trims the over-fetched rows back to the requested limit", async () => {
    // 5 tenant-matching rows returned for a limit of 2 → only 2 survive.
    mocks.run.mockResolvedValueOnce(
      makeRows(
        Array.from({ length: 5 }, (_, i) => ({
          nodeId: `n-${i}`,
          label: "Entity",
          displayName: `node ${i}`,
          properties: null,
          score: 1 - i * 0.1,
        })),
      ),
    );
    const result = await graphSearchHandler({ query: "x", limit: 2 }, CTX);
    expect(result.results).toHaveLength(2);
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphSearchHandler({ query: "x", limit: 5 }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });

  it("always excludes product-owned runtime nodes with a fail-closed predicate", async () => {
    await graphSearchHandler({ query: "x", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).toContain("n.is_system = false");
  });

  // ANN tenant-filter oversampling (silent recall degradation).
  //
  // `db.index.vector.queryNodes` returns the GLOBAL top-k by similarity; the
  // tenant predicate (n.orgId/n.workspaceId) is applied AFTER that call. As
  // other tenants accumulate more/higher-scoring graph volume, a naive query
  // (k === limit) can be entirely crowded out for the active tenant — recall
  // silently shrinks toward zero with no error. This test seeds a synthetic
  // global ranking that reproduces that crowd-out and asserts the shipped
  // implementation (oversampledLimit under the hood) still recovers the full
  // requested K for the target tenant. It fails if graph.search ever
  // regresses to requesting k = limit again.
  it("multi-tenant recall regression: returns the full requested K for the target tenant even though other tenants dominate the global top-K (OXA-1929)", async () => {
    const limit = 8;
    // oversampledLimit(8) = 24, so 16 noise ranks + 24 target ranks (only the
    // first 8 needed within the oversample window) reproduces the crowd-out.
    const globalPool = [
      ...Array.from({ length: 16 }, (_, i) => ({
        nodeId: `noise-${i}`,
        score: 1 - i * 0.001,
        isTarget: false,
      })),
      ...Array.from({ length: 24 }, (_, i) => ({
        nodeId: `target-${i}`,
        score: 0.5 - i * 0.001,
        isTarget: true,
      })),
    ];

    // Sanity check the scenario is a genuine regression case: an unfixed
    // k === limit query against this exact pool starves the target tenant.
    expect(globalPool.slice(0, limit).filter((r) => r.isTarget)).toHaveLength(
      0,
    );

    mocks.run.mockImplementation(
      async (_cypher: string, params: Record<string, unknown>) => {
        const k = Number(params.k as bigint);
        const topK = globalPool.slice(0, k);
        const tenantFiltered = topK.filter((r) => r.isTarget);
        const trimmed = tenantFiltered.slice(0, limit);
        return makeRows(
          trimmed.map((r) => ({
            nodeId: r.nodeId,
            label: "Entity",
            displayName: r.nodeId,
            properties: null,
            score: r.score,
          })),
        );
      },
    );

    const result = await graphSearchHandler({ query: "x", limit }, CTX);
    expect(result.results).toHaveLength(limit);
  });
});
