/**
 * graph.cypher handler tests.
 *
 * Strategy: mock scopedSession() and generateObjectFor to avoid real
 * Neo4j and LLM calls. Verify:
 *   - Raw Cypher mode (nlQuery=false) rejects destructive keywords
 *   - Raw Cypher mode passes valid read-only Cypher to Neo4j unchanged
 *   - NL mode (nlQuery=true) calls generateObjectFor and runs translated Cypher
 *   - NL mode rejects if model returns destructive Cypher
 *   - Result rows and columns are mapped correctly from Neo4j records
 *   - Session is always closed
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  generateObjectFor: vi.fn(),
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

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

import { graphCypherHandler } from "./graph.cypher";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNeoResult(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return { records: [] };
  const keys = Object.keys(rows[0] as Record<string, unknown>);
  return {
    records: rows.map((row) => ({
      keys,
      get: (key: string) => row[key],
    })),
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeNeoResult([]));
  mocks.generateObjectFor.mockResolvedValue({
    object: { cypher: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId RETURN n.publicId AS nodeId LIMIT 5", params: {} },
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  });
});

// ── raw Cypher mode ───────────────────────────────────────────────────────────

describe("graphCypherHandler — raw Cypher mode (nlQuery=false)", () => {
  it("executes a valid read-only query and returns rows + columns", async () => {
    mocks.run.mockResolvedValueOnce(
      makeNeoResult([
        { nodeId: "uuid-1", label: "Person" },
        { nodeId: "uuid-2", label: "Company" },
      ]),
    );

    const result = await graphCypherHandler(
      {
        query: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId RETURN n.publicId AS nodeId, n.label AS label",
        nlQuery: false,
      },
      CTX,
    );

    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(["nodeId", "label"]);
    expect(result.rows[0]).toEqual({ nodeId: "uuid-1", label: "Person" });
  });

  it("returns empty rows and columns for a query with no results", async () => {
    mocks.run.mockResolvedValueOnce(makeNeoResult([]));
    const result = await graphCypherHandler(
      {
        query: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId AND 1=0 RETURN n",
        nlQuery: false,
      },
      CTX,
    );
    expect(result.rowCount).toBe(0);
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("rejects DROP keyword", async () => {
    await expect(
      graphCypherHandler(
        { query: "DROP INDEX my_index", nlQuery: false },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("rejects DELETE keyword", async () => {
    await expect(
      graphCypherHandler(
        {
          query: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId DELETE n",
          nlQuery: false,
        },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("rejects DETACH DELETE keyword", async () => {
    await expect(
      graphCypherHandler(
        {
          query: "MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n",
          nlQuery: false,
        },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("rejects SET keyword", async () => {
    await expect(
      graphCypherHandler(
        {
          query: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId SET n.foo = 1",
          nlQuery: false,
        },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("rejects CREATE keyword", async () => {
    await expect(
      graphCypherHandler(
        { query: "CREATE (n:KnowledgeNode {orgId: $orgId})", nlQuery: false },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("rejects MERGE keyword", async () => {
    await expect(
      graphCypherHandler(
        { query: "MERGE (n:KnowledgeNode {orgId: $orgId})", nlQuery: false },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("is case-insensitive for destructive keyword check", async () => {
    await expect(
      graphCypherHandler(
        { query: "match (n) where n.orgId = $orgId delete n", nlQuery: false },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      graphCypherHandler(
        {
          query: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId RETURN n",
          nlQuery: false,
        },
        CTX,
      ),
    ).rejects.toThrow("connection lost");
    expect(mocks.close).toHaveBeenCalled();
  });
});

// ── NL query mode ─────────────────────────────────────────────────────────────

describe("graphCypherHandler — NL query mode (nlQuery=true)", () => {
  it("calls generateObjectFor and executes the translated Cypher", async () => {
    const translatedCypher =
      "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId AND n.label = 'Person' RETURN n.publicId AS nodeId LIMIT 10";
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { cypher: translatedCypher, params: {} },
      usage: { promptTokens: 15, completionTokens: 25, totalTokens: 40 },
    });
    mocks.run.mockResolvedValueOnce(makeNeoResult([{ nodeId: "uuid-nl" }]));

    const result = await graphCypherHandler(
      { query: "Give me all people in the graph", nlQuery: true },
      CTX,
    );

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith(translatedCypher, expect.any(Object));
    expect(result.rowCount).toBe(1);
    expect((result.rows[0] as Record<string, unknown>)["nodeId"]).toBe("uuid-nl");
  });

  it("does not call generateObjectFor in raw Cypher mode", async () => {
    await graphCypherHandler(
      {
        query: "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId RETURN n",
        nlQuery: false,
      },
      CTX,
    );
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("rejects if the LLM generates a destructive Cypher query", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        cypher: "MATCH (n) WHERE n.orgId = $orgId DELETE n",
        params: {},
      },
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    });

    await expect(
      graphCypherHandler(
        { query: "delete all people", nlQuery: true },
        CTX,
      ),
    ).rejects.toThrow("destructive or mutating keywords");
  });

  it("merges caller params with LLM-generated params", async () => {
    const translatedCypher =
      "MATCH (n:KnowledgeNode) WHERE n.orgId = $orgId AND n.label = $label RETURN n LIMIT $limit";
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { cypher: translatedCypher, params: { label: "Person" } },
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    mocks.run.mockResolvedValueOnce(makeNeoResult([]));

    await graphCypherHandler(
      {
        query: "get people",
        nlQuery: true,
        params: { limit: 5 },
      },
      CTX,
    );

    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.label).toBe("Person");
    expect(params.limit).toBe(5);
  });
});
