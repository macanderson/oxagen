/**
 * graph.node.delete handler tests.
 *
 * Strategy: mock scopedSession() and @oxagen/telemetry so no real Neo4j or
 * ClickHouse connection is required. Verify:
 *   - Cypher scopes by BOTH orgId AND workspaceId (regression guard for the
 *     tenant-isolation bug — org-only scoping let cross-workspace deletes through)
 *   - Returns deleted=true on a hit, deleted=false on a miss
 *   - Emits a destructive-op telemetry row through the shared seam
 *   - Telemetry failures never fail the response (fire-and-forget)
 *   - Closes the session even when the query throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { graphNodeDeleteHandler } from "./graph.node.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeDeleteRecord(wasDeleted: boolean) {
  return {
    records: [{ get: (key: string) => (key === "wasDeleted" ? wasDeleted : null) }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeDeleteRecord(true));
});

describe("graphNodeDeleteHandler", () => {
  it("returns deleted=true when the node existed", async () => {
    mocks.run.mockResolvedValueOnce(makeDeleteRecord(true));
    const result = await graphNodeDeleteHandler({ nodeId: "n-1" }, CTX);
    expect(result.deleted).toBe(true);
  });

  it("returns deleted=false when the node did not exist", async () => {
    mocks.run.mockResolvedValueOnce(makeDeleteRecord(false));
    const result = await graphNodeDeleteHandler({ nodeId: "missing" }, CTX);
    expect(result.deleted).toBe(false);
  });

  it("returns deleted=false when no record is returned", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    const result = await graphNodeDeleteHandler({ nodeId: "missing" }, CTX);
    expect(result.deleted).toBe(false);
  });

  it("scopes the Cypher by BOTH orgId and workspaceId (tenant-isolation guard)", async () => {
    await graphNodeDeleteHandler({ nodeId: "n-2" }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain("orgId: $orgId");
    expect(cypher).toContain("workspaceId: $workspaceId");
  });

  // OXA-2062: the Cypher referenced $orgId/$workspaceId but the local params
  // object omitted both, relying entirely on scopedSession()'s auto-injection.
  // A mocked scopedSession (as used here) does NOT auto-inject, so this bug
  // was invisible to this suite until orgId/workspaceId were bound explicitly.
  it("binds orgId and workspaceId explicitly in the local params object (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await graphNodeDeleteHandler({ nodeId: "n-2" }, CTX);
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.orgId).toBe(CTX.orgId);
    expect(params.workspaceId).toBe(CTX.workspaceId);
  });

  it("emits a destructive-op telemetry row through the shared seam", async () => {
    await graphNodeDeleteHandler({ nodeId: "n-3" }, CTX);
    // fire-and-forget — flush microtasks so the void promise resolves
    await Promise.resolve();
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const row = mocks.insertToolInvocation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.capability_name).toBe("delete_node");
    expect(row.org_id).toBe(CTX.orgId);
    expect(row.workspace_id).toBe(CTX.workspaceId);
    expect(row.risk_level).toBe("high");
    expect(row.status).toBe("completed");
  });

  it("marks telemetry status=failed when the node was not deleted", async () => {
    mocks.run.mockResolvedValueOnce(makeDeleteRecord(false));
    await graphNodeDeleteHandler({ nodeId: "missing" }, CTX);
    await Promise.resolve();
    const row = mocks.insertToolInvocation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.status).toBe("failed");
  });

  it("never fails the response when telemetry insert rejects", async () => {
    mocks.insertToolInvocation.mockRejectedValueOnce(new Error("clickhouse down"));
    const result = await graphNodeDeleteHandler({ nodeId: "n-4" }, CTX);
    expect(result.deleted).toBe(true);
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(graphNodeDeleteHandler({ nodeId: "x" }, CTX)).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
