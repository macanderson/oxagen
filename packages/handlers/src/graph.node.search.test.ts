/**
 * graph.node.search handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - Cypher scopes by BOTH orgId AND workspaceId
 *   - Maps result rows into the contract shape
 *   - Returns an empty array when nothing matches
 *   - Appends a label filter only when labels are supplied
 *   - Passes query/labels/limit as parameters
 *   - Closes the session even when run throws
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

import { graphNodeSearchHandler } from "./graph.node.search";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeRows([]));
});

describe("graphNodeSearchHandler", () => {
  it("maps matching rows into the contract shape", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-1",
          label: "Issue",
          displayName: "Auth bug",
          description: "broken",
          score: 1.0,
        },
      ]),
    );

    const result = await graphNodeSearchHandler(
      { query: "auth", limit: 10 },
      CTX,
    );

    expect(result.nodes).toEqual([
      {
        nodeId: "n-1",
        label: "Issue",
        displayName: "Auth bug",
        description: "broken",
        score: 1.0,
      },
    ]);
  });

  it("returns an empty array when nothing matches", async () => {
    const result = await graphNodeSearchHandler(
      { query: "nope", limit: 10 },
      CTX,
    );
    expect(result.nodes).toEqual([]);
  });

  it("scopes the Cypher by BOTH orgId and workspaceId (tenant-isolation guard)", async () => {
    await graphNodeSearchHandler({ query: "x", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain("n.orgId = $orgId");
    expect(cypher).toContain("n.workspaceId = $workspaceId");
  });

  it("omits the label filter when no labels are supplied", async () => {
    await graphNodeSearchHandler({ query: "x", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).not.toContain("n.label IN $labels");
  });

  it("appends the label filter when labels are supplied", async () => {
    await graphNodeSearchHandler(
      { query: "x", limit: 5, labels: ["Issue"] },
      CTX,
    );
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(cypher).toContain("n.label IN $labels");
    expect(params.labels).toEqual(["Issue"]);
    expect(params.query).toBe("x");
    // Handler wraps LIMIT in BigInt so the Bolt driver sends INTEGER, not Float.
    expect(params.limit).toBe(BigInt(5));
  });

  // The Cypher references $orgId/$workspaceId but the local params
  // object omitted both, relying entirely on scopedSession()'s auto-injection.
  // A mocked scopedSession (as used here) does NOT auto-inject, so this bug
  // was invisible to this suite until orgId/workspaceId were bound explicitly.
  it("binds orgId and workspaceId explicitly in the local params object (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await graphNodeSearchHandler({ query: "x", limit: 5 }, CTX);
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.orgId).toBe(CTX.orgId);
    expect(params.workspaceId).toBe(CTX.workspaceId);
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphNodeSearchHandler({ query: "x", limit: 5 }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
