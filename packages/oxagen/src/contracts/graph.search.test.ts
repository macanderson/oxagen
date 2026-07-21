import { describe, expect, it } from "vitest";
import { graphSearch } from "./graph.search";
import { getCapability } from "../registry";

describe("graph.search capability", () => {
  // ── input: query ──────────────────────────────────────────────────────────

  it("accepts a valid query string", () => {
    const parsed = graphSearch.input.parse({ query: "authentication token" });
    expect(parsed.query).toBe("authentication token");
  });

  it("rejects an empty query string (min 1)", () => {
    expect(() => graphSearch.input.parse({ query: "" })).toThrow();
  });

  it("accepts query exactly at max length (1000 chars)", () => {
    const parsed = graphSearch.input.parse({ query: "a".repeat(1000) });
    expect(parsed.query).toHaveLength(1000);
  });

  it("rejects a query exceeding 1000 characters (max)", () => {
    expect(() =>
      graphSearch.input.parse({ query: "a".repeat(1001) }),
    ).toThrow();
  });

  it("rejects a missing query field", () => {
    expect(() => graphSearch.input.parse({ limit: 5 })).toThrow();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("defaults limit to 10", () => {
    const parsed = graphSearch.input.parse({ query: "test" });
    expect(parsed.limit).toBe(10);
  });

  it("accepts limit=1 (min)", () => {
    const parsed = graphSearch.input.parse({ query: "test", limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=50 (max)", () => {
    const parsed = graphSearch.input.parse({ query: "test", limit: 50 });
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() =>
      graphSearch.input.parse({ query: "test", limit: 0 }),
    ).toThrow();
  });

  it("rejects limit=51 (above max)", () => {
    expect(() =>
      graphSearch.input.parse({ query: "test", limit: 51 }),
    ).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() =>
      graphSearch.input.parse({ query: "test", limit: 2.5 }),
    ).toThrow();
  });

  // ── input: labels (optional) ──────────────────────────────────────────────

  it("defaults labels to undefined", () => {
    const parsed = graphSearch.input.parse({ query: "test" });
    expect(parsed.labels).toBeUndefined();
  });

  it("accepts a labels array", () => {
    const parsed = graphSearch.input.parse({
      query: "test",
      labels: ["Person", "Company"],
    });
    expect(parsed.labels).toEqual(["Person", "Company"]);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with results", () => {
    const parsed = graphSearch.output.parse({
      results: [
        {
          nodeId: "node_abc",
          label: "Document",
          displayName: "Authentication policy",
          kind: "entity",
          snippet: "Refresh tokens expire after 30 days.",
          score: 0.94,
        },
      ],
    });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.nodeId).toBe("node_abc");
    expect(parsed.results[0]?.kind).toBe("entity");
    expect(parsed.results[0]?.score).toBe(0.94);
  });

  it("parses an empty results array", () => {
    const parsed = graphSearch.output.parse({ results: [] });
    expect(parsed.results).toHaveLength(0);
  });

  it("rejects output missing results field", () => {
    expect(() => graphSearch.output.parse({})).toThrow();
  });

  it("rejects a result missing the score field", () => {
    expect(() =>
      graphSearch.output.parse({
        results: [
          {
            nodeId: "node_abc",
            label: "Document",
            displayName: "Authentication policy",
            kind: "entity",
            snippet: "policy",
            // score missing
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("search_graph")).toBe(graphSearch);
  });
});
