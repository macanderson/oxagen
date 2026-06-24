/**
 * graph.edge.delete handler tests.
 *
 * Strategy: mock scopedSession() and @oxagen/telemetry so no real Neo4j or
 * ClickHouse connection is required. Verify:
 *   - Every edge type dispatches a static Cypher query containing the literal
 *     relationship type AND scopes both endpoints by orgId + workspaceId
 *     (regression guard for the tenant-isolation bug — the previous queries
 *     scoped by orgId only)
 *   - Returns deleted=true on a hit, deleted=false on a miss / empty result
 *   - Emits a destructive-op telemetry row through the shared seam
 *   - Telemetry failures never fail the response (fire-and-forget)
 *   - Closes the session even when the query throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The fixed GRAPH_EDGE_TYPES enum is gone (§3.2): relationship types are now
// workspace-defined. We exercise a representative mix of canonical + custom
// types — all must build a static, tenant-scoped DELETE with the literal type.
const RELATIONSHIP_TYPES = [
  "RELATED_TO",
  "PART_OF",
  "MENTIONS",
  "SIGNED_CONTRACT",
  "EMPLOYS",
] as const;

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  insertToolInvocation: vi.fn(async (_row: Record<string, unknown>) => undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

vi.mock("@oxagen/telemetry", () => ({
  insertToolInvocation: mocks.insertToolInvocation,
}));

import { graphEdgeDeleteHandler } from "./graph.edge.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const FROM = "from-node";
const TO = "to-node";

function makeDeleteRecord(wasDeleted: boolean) {
  return {
    records: [{ get: (key: string) => (key === "wasDeleted" ? wasDeleted : null) }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeDeleteRecord(true));
});

describe("graphEdgeDeleteHandler — happy path", () => {
  it("returns deleted=true when the edge existed", async () => {
    mocks.run.mockResolvedValueOnce(makeDeleteRecord(true));
    const result = await graphEdgeDeleteHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "RELATED_TO" },
      CTX,
    );
    expect(result.deleted).toBe(true);
  });

  it("returns deleted=false when the edge did not exist", async () => {
    mocks.run.mockResolvedValueOnce(makeDeleteRecord(false));
    const result = await graphEdgeDeleteHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "PART_OF" },
      CTX,
    );
    expect(result.deleted).toBe(false);
  });

  it("returns deleted=false when no record is returned", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    const result = await graphEdgeDeleteHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "PART_OF" },
      CTX,
    );
    expect(result.deleted).toBe(false);
  });
});

describe("graphEdgeDeleteHandler — relationship types are scoped and guard-checked", () => {
  for (const edgeType of RELATIONSHIP_TYPES) {
    it(`dispatches a guarded, tenant-scoped query for ${edgeType}`, async () => {
      mocks.run.mockResolvedValueOnce(makeDeleteRecord(true));
      await graphEdgeDeleteHandler({ fromNodeId: FROM, toNodeId: TO, edgeType }, CTX);
      const cypher = mocks.run.mock.calls[0]?.[0] as string;
      // literal relationship type interpolated (safe: passed the lexical guard)
      expect(cypher).toContain(`:${edgeType}]`);
      // BOTH endpoints scoped by orgId + workspaceId (tenant-isolation guard)
      const orgScopes = cypher.match(/orgId: \$orgId/g) ?? [];
      const wsScopes = cypher.match(/workspaceId: \$workspaceId/g) ?? [];
      expect(orgScopes.length).toBe(2);
      expect(wsScopes.length).toBe(2);
    });
  }

  it("rejects an injection-shaped relationship type before any Cypher runs", async () => {
    await expect(
      graphEdgeDeleteHandler(
        { fromNodeId: FROM, toNodeId: TO, edgeType: "`]->()-[:x" },
        CTX,
      ),
    ).rejects.toThrow(/lexical guard/);
    // No query was dispatched — rejection happens before the session opens.
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("graphEdgeDeleteHandler — telemetry", () => {
  it("emits a destructive-op telemetry row through the shared seam", async () => {
    await graphEdgeDeleteHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "MENTIONS" },
      CTX,
    );
    await Promise.resolve();
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const row = mocks.insertToolInvocation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.capability_name).toBe("graph.edge.delete");
    expect(row.org_id).toBe(CTX.orgId);
    expect(row.workspace_id).toBe(CTX.workspaceId);
    expect(row.risk_level).toBe("high");
    expect(row.status).toBe("completed");
  });

  it("never fails the response when telemetry insert rejects", async () => {
    mocks.insertToolInvocation.mockRejectedValueOnce(new Error("clickhouse down"));
    const result = await graphEdgeDeleteHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "DEPENDS_ON" },
      CTX,
    );
    expect(result.deleted).toBe(true);
  });
});

describe("graphEdgeDeleteHandler — error paths", () => {
  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphEdgeDeleteHandler({ fromNodeId: FROM, toNodeId: TO, edgeType: "CAUSED_BY" }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
