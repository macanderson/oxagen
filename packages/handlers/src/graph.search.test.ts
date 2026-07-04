/**
 * graph.search handler tests.
 *
 * Strategy: mock embedText and scopedSession() so no real Neo4j or AI gateway
 * call is required. Verify:
 *   - Calls embedText with executionStepId: null (billing correctness)
 *   - Cypher scopes by BOTH orgId AND workspaceId (tenant isolation)
 *   - Maps result rows into the contract output shape
 *   - Derives correct kind from nodeLabels
 *   - Post-filters by kinds when supplied
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
          isSystem: true,
          nodeLabels: ["GraphNode", "AgentMemory"],
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
        kind: "memory",
        snippet: "OAuth token expired",
        score: 0.95,
        isSystem: true,
      },
    ]);
  });

  it("derives kind correctly from nodeLabels", async () => {
    const cases: [string[], string][] = [
      [["GraphNode", "SourceFile"], "file"],
      [["GraphNode", "SourceSymbol"], "symbol"],
      [["GraphNode", "SourceChunk"], "chunk"],
      [["GraphNode", "Execution"], "execution"],
      [["GraphNode", "AgentMemory"], "memory"],
      [["GraphNode", "Document"], "document"],
      [["GraphNode", "Message"], "message"],
      [["GraphNode", "Person"], "entity"],
    ];

    for (const [nodeLabels, expectedKind] of cases) {
      mocks.run.mockResolvedValueOnce(
        makeRows([
          {
            nodeId: "n-kind",
            label: nodeLabels[1] ?? "Person",
            displayName: "test",
            properties: null,
            isSystem: false,
            nodeLabels,
            score: 0.9,
          },
        ]),
      );
      const result = await graphSearchHandler({ query: "test", limit: 10 }, CTX);
      expect(result.results[0]?.kind).toBe(expectedKind);
      vi.clearAllMocks();
      mocks.embedText.mockResolvedValue(VECTOR);
      mocks.run.mockResolvedValue(makeRows([]));
    }
  });

  it("builds snippet from properties.content when present", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-content",
          label: "SourceChunk",
          displayName: "chunk-1",
          properties: JSON.stringify({ content: "function authenticate()" }),
          isSystem: true,
          nodeLabels: ["GraphNode", "SourceChunk"],
          score: 0.88,
        },
      ]),
    );
    const result = await graphSearchHandler({ query: "authenticate", limit: 5 }, CTX);
    expect(result.results[0]?.snippet).toBe("function authenticate()");
  });

  it("falls back to displayName for snippet when properties has no content", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-fallback",
          label: "Person",
          displayName: "Alice Smith",
          properties: JSON.stringify({ age: 30 }),
          isSystem: false,
          nodeLabels: ["GraphNode", "Person"],
          score: 0.85,
        },
      ]),
    );
    const result = await graphSearchHandler({ query: "alice", limit: 5 }, CTX);
    expect(result.results[0]?.snippet).toBe("Alice Smith");
  });

  it("post-filters results by kinds when provided", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-file",
          label: "SourceFile",
          displayName: "auth.ts",
          properties: null,
          isSystem: true,
          nodeLabels: ["GraphNode", "SourceFile"],
          score: 0.92,
        },
        {
          nodeId: "n-person",
          label: "Person",
          displayName: "Alice",
          properties: null,
          isSystem: false,
          nodeLabels: ["GraphNode", "Person"],
          score: 0.90,
        },
      ]),
    );

    const result = await graphSearchHandler(
      { query: "auth", limit: 10, kinds: ["file"] },
      CTX,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.nodeId).toBe("n-file");
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

  it("over-fetches the index by 3x even without a kinds filter (tenant predicate always post-filters)", async () => {
    await graphSearchHandler({ query: "x", limit: 7 }, CTX);
    const params = mocks.run.mock.calls[0]![1] as Record<string, unknown>;
    // The tenant filter (orgId/workspaceId) is applied AFTER the index call on
    // every query, so k must over-sample regardless of the kinds filter.
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
          isSystem: false,
          nodeLabels: ["Entity"],
          score: 1 - i * 0.1,
        })),
      ),
    );
    const result = await graphSearchHandler({ query: "x", limit: 2 }, CTX);
    expect(result.results).toHaveLength(2);
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(graphSearchHandler({ query: "x", limit: 5 }, CTX)).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });

  it("includes isSystem filter in Cypher when isSystem option is provided", async () => {
    await graphSearchHandler({ query: "x", limit: 5, isSystem: false }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).toContain("coalesce(n.is_system, false) = $isSystem");
  });

  it("omits isSystem clause from Cypher when isSystem option is not provided", async () => {
    await graphSearchHandler({ query: "x", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).not.toContain("coalesce(n.is_system, false) = $isSystem");
  });
});
