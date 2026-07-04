/**
 * graph.edge.upsert handler tests (deprecation alias of graph.relationship.upsert).
 *
 * The fixed GRAPH_EDGE_TYPES enum is gone (§3.2): the relationship type is now
 * any workspace-defined string, validated by the always-on lexical
 * RELATIONSHIP_TYPE_PATTERN guard before it is interpolated into Cypher.
 *
 * Strategy: mock scopedSession() to avoid real Neo4j. Verify:
 *   - Each relationship type dispatches a guarded Cypher query with the literal type
 *   - Returns edgeId in the expected composite format
 *   - Returns created=true on creation, created=false on match
 *   - Throws when no record is returned (missing nodes)
 *   - JSON-encodes properties before passing to Cypher
 *   - An injection-shaped relationship type is rejected before any Cypher runs
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

import { graphEdgeUpsertHandler } from "./graph.edge.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

const FROM = "from-node-uuid";
const TO = "to-node-uuid";

// Representative mix of canonical + workspace-defined relationship types.
const RELATIONSHIP_TYPES = [
  "RELATED_TO",
  "PART_OF",
  "MENTIONS",
  "SIGNED_CONTRACT",
  "EMPLOYS",
] as const;

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
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "RELATED_TO" },
      CTX,
    );
    expect(result.edgeId).toBe(`${FROM}:RELATED_TO:${TO}`);
    expect(result.created).toBe(true);
  });

  it("returns created=false on match", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord(false));
    const result = await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "PART_OF" },
      CTX,
    );
    expect(result.created).toBe(false);
  });

  it("JSON-encodes properties before passing to Cypher", async () => {
    await graphEdgeUpsertHandler(
      {
        fromNodeId: FROM,
        toNodeId: TO,
        relationshipType: "REFERENCES",
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
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "SIMILAR_TO" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.properties).toBeNull();
  });
});

describe("graphEdgeUpsertHandler — relationship types dispatch guarded Cypher", () => {
  for (const relationshipType of RELATIONSHIP_TYPES) {
    it(`dispatches a guarded Cypher query for ${relationshipType}`, async () => {
      mocks.run.mockResolvedValueOnce(makeRecord(true));
      const result = await graphEdgeUpsertHandler(
        { fromNodeId: FROM, toNodeId: TO, relationshipType },
        CTX,
      );
      // The Cypher string must contain the literal relationship type (safe: it
      // passed the lexical guard).
      const cypher = mocks.run.mock.calls[0]?.[0] as string;
      expect(cypher).toContain(`:${relationshipType}]`);
      expect(result.edgeId).toBe(`${FROM}:${relationshipType}:${TO}`);
    });
  }
});

describe("graphEdgeUpsertHandler — Cypher-injection guard (§3.2/§13)", () => {
  it("rejects an injection-shaped relationship type before any Cypher runs", async () => {
    await expect(
      graphEdgeUpsertHandler(
        { fromNodeId: FROM, toNodeId: TO, relationshipType: "`]->()-[:x" },
        CTX,
      ),
    ).rejects.toThrow(/lexical guard/);
    // No query dispatched — the guard fires before the session opens.
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects a lowercase relationship type before any Cypher runs", async () => {
    await expect(
      graphEdgeUpsertHandler(
        { fromNodeId: FROM, toNodeId: TO, relationshipType: "knows" },
        CTX,
      ),
    ).rejects.toThrow(/lexical guard/);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("graphEdgeUpsertHandler — error paths", () => {
  it("throws when Neo4j returns no record (nodes do not exist)", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(
      graphEdgeUpsertHandler(
        { fromNodeId: "missing-from", toNodeId: "missing-to", relationshipType: "DEPENDS_ON" },
        CTX,
      ),
    ).rejects.toThrow("no record returned");
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphEdgeUpsertHandler(
        { fromNodeId: FROM, toNodeId: TO, relationshipType: "MENTIONS" },
        CTX,
      ),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});

// ── bi-temporal validity + supersession ───────────────────────────────────────

function makeUpsertRecord(wasCreated: boolean) {
  return makeRecord(wasCreated);
}
function makeCloseRecord(closed: number) {
  return { records: [{ get: (k: string) => (k === "closed" ? closed : null) }] };
}

describe("graphEdgeUpsertHandler — bi-temporal validity stamping", () => {
  it("ON CREATE stamps validFrom/recordedAt with open bounds; ON MATCH reopens", async () => {
    await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "EMPLOYS" },
      CTX,
    );
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    // ON CREATE: valid-time + transaction-time start, open upper bounds.
    expect(cypher).toContain("r.validFrom = coalesce(datetime($validFrom), datetime())");
    expect(cypher).toContain("r.recordedAt = datetime()");
    expect(cypher).toMatch(/ON CREATE SET[\s\S]*r.validTo = null/);
    expect(cypher).toMatch(/ON CREATE SET[\s\S]*r.invalidatedAt = null/);
    // ON MATCH: re-assert (reopen) while preserving original lower bounds.
    expect(cypher).toContain("r.validFrom = coalesce(r.validFrom, datetime($validFrom), datetime())");
    expect(cypher).toMatch(/ON MATCH SET[\s\S]*r.invalidatedAt = null/);
  });

  it("threads observedAt through as the $validFrom param", async () => {
    await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "EMPLOYS", observedAt: "2020-05-01T00:00:00.000Z" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.validFrom).toBe("2020-05-01T00:00:00.000Z");
  });

  it("passes validFrom=null when observedAt omitted (Cypher falls back to now)", async () => {
    await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "EMPLOYS" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.validFrom).toBeNull();
  });

  it("does not supersede by default — one query, superseded=0", async () => {
    const result = await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "EMPLOYS" },
      CTX,
    );
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(result.superseded).toBe(0);
  });
});

describe("graphEdgeUpsertHandler — supersession (opt-in)", () => {
  it("closes other open edges of the same type from the source before upserting", async () => {
    // call[0] = supersede-close (returns closed count); call[1] = upsert (created).
    mocks.run.mockResolvedValueOnce(makeCloseRecord(2));
    mocks.run.mockResolvedValueOnce(makeUpsertRecord(true));

    const result = await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "EMPLOYS", supersede: true },
      CTX,
    );

    expect(mocks.run).toHaveBeenCalledTimes(2);
    const closeCypher = mocks.run.mock.calls[0]?.[0] as string;
    // Closes only OTHER open targets — never deletes, never touches the new target.
    expect(closeCypher).toContain("other.publicId <> $toNodeId");
    expect(closeCypher).toContain("old.validTo IS NULL AND old.invalidatedAt IS NULL");
    expect(closeCypher).toContain("old.validTo = coalesce(old.validTo, datetime($closedAt))");
    expect(closeCypher).not.toMatch(/DELETE/i);
    expect(result.superseded).toBe(2);
    expect(result.created).toBe(true);
  });

  it("reports superseded=0 when no conflicting edges exist", async () => {
    mocks.run.mockResolvedValueOnce(makeCloseRecord(0));
    mocks.run.mockResolvedValueOnce(makeUpsertRecord(true));
    const result = await graphEdgeUpsertHandler(
      { fromNodeId: FROM, toNodeId: TO, relationshipType: "EMPLOYS", supersede: true },
      CTX,
    );
    expect(result.superseded).toBe(0);
  });
});
