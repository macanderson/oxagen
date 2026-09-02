import { describe, expect, it } from "vitest";
import { graphNodeSearch } from "./graph.node.search";
import { getCapability } from "../registry";

describe("graph.node.search capability", () => {
  // ── input: query ──────────────────────────────────────────────────────────

  it("accepts a valid query string", () => {
    const parsed = graphNodeSearch.input.parse({ query: "Alice" });
    expect(parsed.query).toBe("Alice");
  });

  it("rejects an empty query string (min 1)", () => {
    expect(() => graphNodeSearch.input.parse({ query: "" })).toThrow();
  });

  it("accepts query exactly at max length (500 chars)", () => {
    const parsed = graphNodeSearch.input.parse({ query: "a".repeat(500) });
    expect(parsed.query).toHaveLength(500);
  });

  it("rejects a query exceeding 500 characters (max)", () => {
    expect(() =>
      graphNodeSearch.input.parse({ query: "a".repeat(501) }),
    ).toThrow();
  });

  it("rejects a missing query field", () => {
    expect(() => graphNodeSearch.input.parse({ limit: 5 })).toThrow();
  });

  it("rejects a non-string query", () => {
    expect(() => graphNodeSearch.input.parse({ query: 42 })).toThrow();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("defaults limit to 10", () => {
    const parsed = graphNodeSearch.input.parse({ query: "test" });
    expect(parsed.limit).toBe(10);
  });

  it("accepts limit=1 (min)", () => {
    const parsed = graphNodeSearch.input.parse({ query: "test", limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=50 (max)", () => {
    const parsed = graphNodeSearch.input.parse({ query: "test", limit: 50 });
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() =>
      graphNodeSearch.input.parse({ query: "test", limit: 0 }),
    ).toThrow();
  });

  it("rejects limit=51 (above max)", () => {
    expect(() =>
      graphNodeSearch.input.parse({ query: "test", limit: 51 }),
    ).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() =>
      graphNodeSearch.input.parse({ query: "test", limit: 2.5 }),
    ).toThrow();
  });

  // ── input: labels (optional) ──────────────────────────────────────────────

  it("defaults labels to undefined", () => {
    const parsed = graphNodeSearch.input.parse({ query: "test" });
    expect(parsed.labels).toBeUndefined();
  });

  it("accepts a labels array of strings", () => {
    const parsed = graphNodeSearch.input.parse({
      query: "test",
      labels: ["Person", "Company"],
    });
    expect(parsed.labels).toEqual(["Person", "Company"]);
  });

  it("accepts an empty labels array", () => {
    const parsed = graphNodeSearch.input.parse({ query: "test", labels: [] });
    expect(parsed.labels).toEqual([]);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with nodes", () => {
    const parsed = graphNodeSearch.output.parse({
      nodes: [
        {
          nodeId: "kn_123",
          label: "Person",
          displayName: "Alice",
          description: "A developer",
          score: 1.0,
        },
      ],
    });
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.nodeId).toBe("kn_123");
    expect(parsed.nodes[0]?.label).toBe("Person");
    expect(parsed.nodes[0]?.displayName).toBe("Alice");
    expect(parsed.nodes[0]?.description).toBe("A developer");
    expect(parsed.nodes[0]?.score).toBe(1.0);
  });

  it("parses a node with null description", () => {
    const parsed = graphNodeSearch.output.parse({
      nodes: [
        {
          nodeId: "kn_456",
          label: "Topic",
          displayName: "AI",
          description: null,
          score: 0.5,
        },
      ],
    });
    expect(parsed.nodes[0]?.description).toBeNull();
    expect(parsed.nodes[0]?.score).toBe(0.5);
  });

  it("parses an empty nodes array", () => {
    const parsed = graphNodeSearch.output.parse({ nodes: [] });
    expect(parsed.nodes).toHaveLength(0);
  });

  it("rejects output missing nodes field", () => {
    expect(() => graphNodeSearch.output.parse({})).toThrow();
  });

  it("rejects a node missing the score field", () => {
    expect(() =>
      graphNodeSearch.output.parse({
        nodes: [
          {
            nodeId: "kn_123",
            label: "Person",
            displayName: "Alice",
            description: null,
            // score missing
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("search_nodes")).toBe(graphNodeSearch);
  });
});
