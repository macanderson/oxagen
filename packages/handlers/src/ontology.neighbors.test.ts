/**
 * ontology.neighbors handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - The existence + neighbor queries scope by BOTH orgId AND workspaceId
 *   - A missing node reports found:false with no neighbors and no traversal query
 *   - Neighbors are mapped into the contract shape with edge type + direction
 *   - The direction filter clause is applied for 'out' / 'in' and omitted for 'both'
 *   - Truncation is flagged when more neighbors exist than `limit`
 *   - The session is closed even when a query throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  getPinnedSchema: vi.fn(async (..._a: unknown[]) => null as unknown),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

// The §3.2 guard resolves the pinned active vocabulary via getPinnedSchema.
// Default: no version pinned (lexical guard stands alone).
vi.mock("./schema.pinned", () => ({
  getPinnedSchema: (...a: unknown[]) => mocks.getPinnedSchema(...a),
}));

/** Build a minimal PinnedSchema whose active vocabulary has the given rel types. */
function pinnedWith(relTypes: string[]): unknown {
  return {
    registryId: "scr_1",
    versionId: "scv_1",
    versionNumber: 1,
    enforcementMode: "lenient",
    conformanceFloor: 0.5,
    labels: [],
    relationshipTypes: relTypes.map((name) => ({
      schemaName: "s",
      name,
      displayName: name,
      description: null,
      startLabel: null,
      endLabel: null,
      cardinality: null,
      properties: [],
    })),
  };
}

import { ontologyNeighborsHandler } from "./ontology.neighbors";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

const EXISTS = makeRows([{ nodeId: "n-1" }]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeRows([]));
  mocks.getPinnedSchema.mockResolvedValue(null);
});

describe("ontologyNeighborsHandler", () => {
  it("reports found:false and runs no traversal when the node is missing", async () => {
    mocks.run.mockResolvedValueOnce(makeRows([])); // existence: not found
    const result = await ontologyNeighborsHandler(
      { nodeId: "missing", direction: "both", limit: 100 },
      CTX,
    );
    expect(result.found).toBe(false);
    expect(result.neighbors).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("scopes both queries by orgId and workspaceId (tenant-isolation guard)", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    const existsCypher = mocks.run.mock.calls[0]?.[0] as string;
    const neighborCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(existsCypher).toContain("orgId: $orgId");
    expect(existsCypher).toContain("workspaceId: $workspaceId");
    expect(neighborCypher).toContain("m.orgId = $orgId");
    expect(neighborCypher).toContain("m.workspaceId = $workspaceId");
  });

  it("maps neighbors into the contract shape with edge type and direction", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-2",
          label: "Topic",
          displayName: "Auth",
          description: "area",
          edgeType: "RELATED_TO",
          direction: "out",
        },
      ]),
    );
    const result = await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    expect(result.found).toBe(true);
    expect(result.neighbors).toEqual([
      {
        nodeId: "n-2",
        label: "Topic",
        displayName: "Auth",
        description: "area",
        edgeType: "RELATED_TO",
        direction: "out",
        // Bi-temporal validity — all-null for an unstamped edge (mock returns null).
        validFrom: null,
        validTo: null,
        recordedAt: null,
        invalidatedAt: null,
      },
    ]);
  });

  it("requires both endpoints to be customer-context nodes", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    const cypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(cypher).toContain("n.is_system = false");
    expect(cypher).toContain("m.is_system = false");
  });

  it("applies the direction filter for 'out' and omits it for 'both'", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "out", limit: 10 },
      CTX,
    );
    expect(mocks.run.mock.calls[1]?.[0]).toContain("startNode(r) = n");

    vi.clearAllMocks();
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 10 },
      CTX,
    );
    const bothCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(bothCypher).not.toContain("startNode(r) = n\n");
  });

  it("flags truncation when more neighbors exist than the limit", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "n-2",
          label: "T",
          displayName: "A",
          description: null,
          edgeType: "RELATED_TO",
          direction: "out",
        },
        {
          nodeId: "n-3",
          label: "T",
          displayName: "B",
          description: null,
          edgeType: "RELATED_TO",
          direction: "in",
        },
      ]),
    );
    const result = await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 1 },
      CTX,
    );
    expect(result.neighbors).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("closes the session even when a query throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      ontologyNeighborsHandler(
        { nodeId: "n-1", direction: "both", limit: 100 },
        CTX,
      ),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});

describe("ontologyNeighborsHandler — §3.2 Cypher-injection + active-vocabulary guard", () => {
  it("rejects an injection-shaped relationship type before any Cypher runs", async () => {
    await expect(
      ontologyNeighborsHandler(
        // The classic Cypher-injection payload: break out of the rel-type list.
        {
          nodeId: "n-1",
          edgeTypes: ["`]->()-[:x"],
          direction: "both",
          limit: 100,
        },
        CTX,
      ),
    ).rejects.toThrow(/lexical guard/);
    // Guard fires before the existence query — no Cypher dispatched at all.
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects a relationship type absent from the pinned active vocabulary", async () => {
    mocks.getPinnedSchema.mockResolvedValue(
      pinnedWith(["EMPLOYS", "SIGNED_CONTRACT"]),
    );
    await expect(
      ontologyNeighborsHandler(
        { nodeId: "n-1", edgeTypes: ["KNOWS"], direction: "both", limit: 100 },
        CTX,
      ),
    ).rejects.toThrow(/active vocabulary/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("accepts a pinned active-vocabulary relationship type and passes it as a Cypher PARAMETER", async () => {
    mocks.getPinnedSchema.mockResolvedValue(pinnedWith(["EMPLOYS"]));
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", edgeTypes: ["EMPLOYS"], direction: "both", limit: 100 },
      CTX,
    );
    const neighborCypher = mocks.run.mock.calls[1]?.[0] as string;
    const neighborParams = mocks.run.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    // The relationship type is filtered via a PARAMETER, never concatenated.
    expect(neighborCypher).toContain("type(r) IN $edgeTypes");
    expect(neighborParams["edgeTypes"]).toEqual(["EMPLOYS"]);
  });

  it("defaults the omitted filter to the pinned active vocabulary, not a static list", async () => {
    mocks.getPinnedSchema.mockResolvedValue(
      pinnedWith(["EMPLOYS", "SIGNED_CONTRACT"]),
    );
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    const neighborParams = mocks.run.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(neighborParams["edgeTypes"]).toEqual(["EMPLOYS", "SIGNED_CONTRACT"]);
  });

  it("traverses unconstrained (no rel-type clause) when nothing pinned and no filter", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    const neighborCypher = mocks.run.mock.calls[1]?.[0] as string;
    expect(neighborCypher).not.toContain("type(r) IN $edgeTypes");
  });
});

// ── bi-temporal time-aware reads ──────────────────────────────────────────────

describe("ontologyNeighborsHandler — asOf / asKnownAt validity filter", () => {
  it("applies the validity filter and projects validity columns by default", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    const cypher = mocks.run.mock.calls[1]?.[0] as string;
    // Filter present (both time axes), null-safe for unstamped legacy edges.
    expect(cypher).toContain(
      "r.validFrom IS NULL OR r.validFrom <= datetime($asOf)",
    );
    expect(cypher).toContain(
      "r.validTo IS NULL OR r.validTo > datetime($asOf)",
    );
    expect(cypher).toContain(
      "r.recordedAt IS NULL OR r.recordedAt <= datetime($asKnownAt)",
    );
    expect(cypher).toContain(
      "r.invalidatedAt IS NULL OR r.invalidatedAt > datetime($asKnownAt)",
    );
    // Validity projected back for citation.
    expect(cypher).toContain("toString(r.validFrom) AS validFrom");
  });

  it("defaults asOf / asKnownAt params to ~now when omitted", async () => {
    const before = Date.now();
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      { nodeId: "n-1", direction: "both", limit: 100 },
      CTX,
    );
    const params = mocks.run.mock.calls[1]?.[1] as Record<string, string>;
    expect(new Date(String(params.asOf)).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(new Date(String(params.asKnownAt)).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it("threads explicit asOf / asKnownAt through as params", async () => {
    mocks.run.mockResolvedValueOnce(EXISTS).mockResolvedValueOnce(makeRows([]));
    await ontologyNeighborsHandler(
      {
        nodeId: "n-1",
        direction: "both",
        limit: 100,
        asOf: "2020-01-01T00:00:00.000Z",
        asKnownAt: "2021-01-01T00:00:00.000Z",
      },
      CTX,
    );
    const params = mocks.run.mock.calls[1]?.[1] as Record<string, string>;
    expect(params.asOf).toBe("2020-01-01T00:00:00.000Z");
    expect(params.asKnownAt).toBe("2021-01-01T00:00:00.000Z");
  });
});
