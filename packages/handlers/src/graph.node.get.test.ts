/**
 * graph.node.get handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - Cypher scopes by BOTH orgId AND workspaceId (regression guard for the
 *     tenant-isolation bug — org-only scoping let cross-workspace reads through)
 *   - Returns the mapped node on a hit, null on a miss
 *   - JSON-decodes the properties column; null when absent
 *   - Closes the session even when the query throws
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

import { graphNodeGetHandler } from "./graph.node.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNodeRecord(fields: Record<string, unknown>) {
  return {
    records: [
      {
        get: (key: string) => (key in fields ? fields[key] : null),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("graphNodeGetHandler", () => {
  it("returns the mapped node on a hit", async () => {
    mocks.run.mockResolvedValueOnce(
      makeNodeRecord({
        nodeId: "node-1",
        label: "Issue",
        displayName: "Fix auth",
        description: "desc",
        properties: JSON.stringify({ status: "open" }),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    );

    const result = await graphNodeGetHandler({ nodeId: "node-1" }, CTX);

    expect(result.node).toEqual({
      nodeId: "node-1",
      label: "Issue",
      displayName: "Fix auth",
      description: "desc",
      properties: { status: "open" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("returns null when the node is not found", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    const result = await graphNodeGetHandler({ nodeId: "missing" }, CTX);
    expect(result.node).toBeNull();
  });

  it("returns null properties when the column is null", async () => {
    mocks.run.mockResolvedValueOnce(
      makeNodeRecord({
        nodeId: "node-2",
        label: "Topic",
        displayName: "Neo4j",
        description: null,
        properties: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
      }),
    );
    const result = await graphNodeGetHandler({ nodeId: "node-2" }, CTX);
    expect(result.node?.properties).toBeNull();
    expect(result.node?.updatedAt).toBeNull();
    expect(result.node?.description).toBeNull();
  });

  it("resolves with {} properties instead of rejecting on a malformed JSON blob", async () => {
    // Regression: an unguarded JSON.parse here 500'd the API and the detail
    // panel showed "Failed to load node detail." for any node with a corrupt
    // properties column.
    mocks.run.mockResolvedValueOnce(
      makeNodeRecord({
        nodeId: "node-bad",
        label: "Issue",
        displayName: "Corrupt props",
        description: null,
        properties: "{not valid json",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
      }),
    );

    const result = await graphNodeGetHandler({ nodeId: "node-bad" }, CTX);
    expect(result.node?.properties).toEqual({});
    expect(result.node?.displayName).toBe("Corrupt props");
  });

  it("passes native driver map properties through without JSON.parse", async () => {
    mocks.run.mockResolvedValueOnce(
      makeNodeRecord({
        nodeId: "node-native",
        label: "Topic",
        displayName: "Native map",
        description: null,
        properties: { status: "open", nested: { deep: true } },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
      }),
    );

    const result = await graphNodeGetHandler({ nodeId: "node-native" }, CTX);
    expect(result.node?.properties).toEqual({
      status: "open",
      nested: { deep: true },
    });
  });

  it("returns {} properties for a JSON blob that is not an object", async () => {
    mocks.run.mockResolvedValueOnce(
      makeNodeRecord({
        nodeId: "node-scalar",
        label: "Topic",
        displayName: "Scalar props",
        description: null,
        properties: '"double-encoded"',
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
      }),
    );

    const result = await graphNodeGetHandler({ nodeId: "node-scalar" }, CTX);
    expect(result.node?.properties).toEqual({});
  });

  it("scopes the Cypher by BOTH orgId and workspaceId (tenant-isolation guard)", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await graphNodeGetHandler({ nodeId: "node-3" }, CTX);

    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain("orgId: $orgId");
    expect(cypher).toContain("workspaceId: $workspaceId");
  });

  it("passes the nodeId as a parameter (no interpolation)", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await graphNodeGetHandler({ nodeId: "node-4" }, CTX);
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.nodeId).toBe("node-4");
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(graphNodeGetHandler({ nodeId: "x" }, CTX)).rejects.toThrow(
      "Neo4j down",
    );
    expect(mocks.close).toHaveBeenCalled();
  });
});
