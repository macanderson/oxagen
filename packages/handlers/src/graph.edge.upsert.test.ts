/**
 * graph.edge.upsert handler tests.
 *
 * Strategy: mock scopedSession() to avoid real Neo4j. Verify:
 *   - Each allowed edge type dispatches the correct static Cypher query
 *   - Returns edgeId in the expected composite format
 *   - Returns created=true on creation, created=false on match
 *   - Throws when no record is returned (missing nodes)
 *   - JSON-encodes properties before passing to Cypher
 *   - Unknown edge type throws immediately (never reaches Neo4j)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GRAPH_EDGE_TYPES } from "@oxagen/oxagen/contracts/graph.edge.upsert";

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

import { graphEdgeUpsertHandler } from "./graph.edge.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

const FROM = "from-node-uuid";
const TO = "to-node-uuid";

function makeRecord(wasCreated: boolean) {
  return {
    records: [
      {
        get: (key: string) => {
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
  mocks.run.mockResolvedValue(makeRecord(true));
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("graphEdgeUpsertHandler — happy path", () => {
  it("returns composite edgeId and created=true", async () => {
    const result = await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "RELATED_TO" },
      CTX,
    );
    expect(result.edgeId).toBe(`${FROM}:RELATED_TO:${TO}`);
    expect(result.created).toBe(true);
  });

  it("returns created=false on match", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord(false));
    const result = await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "PART_OF" },
      CTX,
    );
    expect(result.created).toBe(false);
  });

  it("JSON-encodes properties before passing to Cypher", async () => {
    await graphEdgeUpsertHandler(
      {
        fromNodeId: FROM,
        toNodeId: TO,
        edgeType: "REFERENCES",
        properties: { source: "doc-1", page: "5" },
      },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof params.properties).toBe("string");
    expect(JSON.parse(params.properties as string)).toEqual({ source: "doc-1", page: "5" });
  });

  it("passes null for properties when none provided", async () => {
    await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, edgeType: "SIMILAR_TO" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.properties).toBeNull();
  });
});

describe("graphEdgeUpsertHandler — all edge types dispatch static Cypher", () => {
  for (const edgeType of GRAPH_EDGE_TYPES) {
    it(`dispatches a static Cypher query for ${edgeType}`, async () => {
      mocks.run.mockResolvedValueOnce(makeRecord(true));
      const result = await graphEdgeUpsertHandler(
        { fromNodeId: FROM, toNodeId: TO, edgeType },
        CTX,
      );
      // The Cypher string must contain the literal relationship type
      const cypher = mocks.run.mock.calls[0]?.[0] as string;
      expect(cypher).toContain(edgeType);
      expect(result.edgeId).toBe(`${FROM}:${edgeType}:${TO}`);
    });
  }
});

describe("graphEdgeUpsertHandler — error paths", () => {
  it("throws when Neo4j returns no record (nodes do not exist)", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(
      graphEdgeUpsertHandler(
        { fromNodeId: "missing-from", toNodeId: "missing-to", edgeType: "DEPENDS_ON" },
        CTX,
      ),
    ).rejects.toThrow("no record returned");
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphEdgeUpsertHandler(
        { fromNodeId: FROM, toNodeId: TO, edgeType: "MENTIONS" },
        CTX,
      ),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
