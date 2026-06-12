import { describe, expect, it } from "vitest";
import { graphNodeList } from "./graph.node.list";
import { getCapability } from "../registry";

describe("graph.node.list capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults limit to 50 on empty input", () => {
    const parsed = graphNodeList.input.parse({});
    expect(parsed.limit).toBe(50);
  });

  it("defaults offset to 0 on empty input", () => {
    const parsed = graphNodeList.input.parse({});
    expect(parsed.offset).toBe(0);
  });

  it("defaults labels to undefined", () => {
    const parsed = graphNodeList.input.parse({});
    expect(parsed.labels).toBeUndefined();
  });

  it("defaults sourceId to undefined", () => {
    const parsed = graphNodeList.input.parse({});
    expect(parsed.sourceId).toBeUndefined();
  });

  it("defaults query to undefined", () => {
    const parsed = graphNodeList.input.parse({});
    expect(parsed.query).toBeUndefined();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = graphNodeList.input.parse({ limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=250 (max)", () => {
    const parsed = graphNodeList.input.parse({ limit: 250 });
    expect(parsed.limit).toBe(250);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() => graphNodeList.input.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit=251 (above max)", () => {
    expect(() => graphNodeList.input.parse({ limit: 251 })).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() => graphNodeList.input.parse({ limit: 1.5 })).toThrow();
  });

  // ── input: offset bounds ──────────────────────────────────────────────────

  it("accepts offset=0 (min)", () => {
    const parsed = graphNodeList.input.parse({ offset: 0 });
    expect(parsed.offset).toBe(0);
  });

  it("accepts a positive offset", () => {
    const parsed = graphNodeList.input.parse({ offset: 100 });
    expect(parsed.offset).toBe(100);
  });

  it("rejects offset=-1 (below min)", () => {
    expect(() => graphNodeList.input.parse({ offset: -1 })).toThrow();
  });

  it("rejects a non-integer offset", () => {
    expect(() => graphNodeList.input.parse({ offset: 2.5 })).toThrow();
  });

  // ── input: optional fields ────────────────────────────────────────────────

  it("accepts labels as an array of strings", () => {
    const parsed = graphNodeList.input.parse({ labels: ["Person", "Company"] });
    expect(parsed.labels).toEqual(["Person", "Company"]);
  });

  it("accepts sourceId as a string", () => {
    const parsed = graphNodeList.input.parse({ sourceId: "src_123" });
    expect(parsed.sourceId).toBe("src_123");
  });

  it("accepts query as a text string", () => {
    const parsed = graphNodeList.input.parse({ query: "search term" });
    expect(parsed.query).toBe("search term");
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with nodes", () => {
    const parsed = graphNodeList.output.parse({
      nodes: [
        {
          id: "neo4j-uuid-1",
          labels: ["Person"],
          properties: { name: "Alice" },
          displayName: "Alice",
          sourceId: "src_123",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.id).toBe("neo4j-uuid-1");
    expect(parsed.nodes[0]?.labels).toEqual(["Person"]);
    expect(parsed.nodes[0]?.displayName).toBe("Alice");
    expect(parsed.total).toBe(1);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("parses a node with optional sourceId and createdAt omitted", () => {
    const parsed = graphNodeList.output.parse({
      nodes: [
        {
          id: "neo4j-uuid-2",
          labels: ["Topic"],
          properties: {},
          displayName: "AI",
        },
      ],
      total: 1,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
    expect(parsed.nodes[0]?.sourceId).toBeUndefined();
    expect(parsed.nodes[0]?.createdAt).toBeUndefined();
  });

  it("parses an empty nodes list", () => {
    const parsed = graphNodeList.output.parse({
      nodes: [],
      total: 0,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
    expect(parsed.nodes).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it("rejects output missing total field", () => {
    expect(() =>
      graphNodeList.output.parse({
        nodes: [],
        hasMore: false,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("graph.node.list")).toBe(graphNodeList);
  });
});
