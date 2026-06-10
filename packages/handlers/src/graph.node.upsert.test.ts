/**
 * graph.node.upsert handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - MERGE uses naturalKey derived from externalId when provided
 *   - MERGE falls back to label+displayName+workspaceId when no externalId
 *   - Returns nodeId and created=true on create, created=false on match
 *   - Throws when MERGE returns no record
 *   - JSON-encodes properties before passing to Cypher
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
  runInTenantScope: async (
    _scope: unknown,
    fn: () => Promise<void>,
  ) => fn(),
}));

import { graphNodeUpsertHandler } from "./graph.node.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRecord(nodeId: string, wasCreated: boolean) {
  return {
    records: [
      {
        get: (key: string) => {
          if (key === "nodeId") return nodeId;
          if (key === "wasCreated") return wasCreated;
          return null;
        },
      },
    ],
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeRecord("node-uuid-1", true));
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("graphNodeUpsertHandler", () => {
  it("returns nodeId and created=true on node creation", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord("node-uuid-1", true));
    const result = await graphNodeUpsertHandler(
      { label: "Person", displayName: "Alice" },
      CTX,
    );
    expect(result.nodeId).toBe("node-uuid-1");
    expect(result.created).toBe(true);
  });

  it("returns created=false when node already exists", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord("node-uuid-existing", false));
    const result = await graphNodeUpsertHandler(
      { label: "Company", displayName: "Acme Inc" },
      CTX,
    );
    expect(result.nodeId).toBe("node-uuid-existing");
    expect(result.created).toBe(false);
  });

  it("uses ext: prefix in naturalKey when externalId is provided", async () => {
    await graphNodeUpsertHandler(
      { label: "Person", displayName: "Bob", externalId: "ext-bob-123" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.naturalKey).toBe("ext:ext-bob-123");
  });

  it("uses label+displayName+workspaceId as naturalKey when no externalId", async () => {
    await graphNodeUpsertHandler(
      { label: "Topic", displayName: "TypeScript" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.naturalKey).toBe(`Topic:TypeScript:${CTX.workspaceId}`);
  });

  it("JSON-encodes properties before passing to Cypher", async () => {
    await graphNodeUpsertHandler(
      {
        label: "Person",
        displayName: "Carol",
        properties: { role: "engineer", level: 5 },
      },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof params.properties).toBe("string");
    expect(JSON.parse(params.properties as string)).toEqual({ role: "engineer", level: 5 });
  });

  it("passes null for properties when none provided", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Dave" }, CTX);
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.properties).toBeNull();
  });

  it("passes description to Cypher", async () => {
    await graphNodeUpsertHandler(
      { label: "Topic", displayName: "Neo4j", description: "Graph database" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.description).toBe("Graph database");
  });

  it("throws when MERGE returns no record", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(
      graphNodeUpsertHandler({ label: "Person", displayName: "Eve" }, CTX),
    ).rejects.toThrow("graph.node.upsert: MERGE returned no record");
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphNodeUpsertHandler({ label: "Person", displayName: "Frank" }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
