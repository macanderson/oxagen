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
    expect(() => graphSearch.input.parse({ query: "a".repeat(1001) })).toThrow();
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
    expect(() => graphSearch.input.parse({ query: "test", limit: 0 })).toThrow();
  });

  it("rejects limit=51 (above max)", () => {
    expect(() => graphSearch.input.parse({ query: "test", limit: 51 })).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() => graphSearch.input.parse({ query: "test", limit: 2.5 })).toThrow();
  });

  // ── input: kinds (optional) ───────────────────────────────────────────────

  it("defaults kinds to undefined", () => {
    const parsed = graphSearch.input.parse({ query: "test" });
    expect(parsed.kinds).toBeUndefined();
  });

  it("accepts a valid kinds array", () => {
    const parsed = graphSearch.input.parse({
      query: "test",
      kinds: ["entity", "file", "symbol", "chunk", "memory", "execution", "document", "message"],
    });
    expect(parsed.kinds).toEqual([
      "entity",
      "file",
      "symbol",
      "chunk",
      "memory",
      "execution",
      "document",
      "message",
    ]);
  });

  it("accepts an empty kinds array", () => {
    const parsed = graphSearch.input.parse({ query: "test", kinds: [] });
    expect(parsed.kinds).toEqual([]);
  });

  it("rejects an invalid kind value", () => {
    expect(() =>
      graphSearch.input.parse({ query: "test", kinds: ["invalid_kind"] }),
    ).toThrow();
  });

  // ── input: isSystem (optional) ────────────────────────────────────────────

  it("defaults isSystem to undefined", () => {
    const parsed = graphSearch.input.parse({ query: "test" });
    expect(parsed.isSystem).toBeUndefined();
  });

  it("accepts isSystem=true", () => {
    const parsed = graphSearch.input.parse({ query: "test", isSystem: true });
    expect(parsed.isSystem).toBe(true);
  });

  it("accepts isSystem=false", () => {
    const parsed = graphSearch.input.parse({ query: "test", isSystem: false });
    expect(parsed.isSystem).toBe(false);
  });

  // ── input: labels (optional) ──────────────────────────────────────────────

  it("defaults labels to undefined", () => {
    const parsed = graphSearch.input.parse({ query: "test" });
    expect(parsed.labels).toBeUndefined();
  });

  it("accepts a labels array", () => {
    const parsed = graphSearch.input.parse({
      query: "test",
      labels: ["Person", "SourceFile"],
    });
    expect(parsed.labels).toEqual(["Person", "SourceFile"]);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with results", () => {
    const parsed = graphSearch.output.parse({
      results: [
        {
          nodeId: "node_abc",
          label: "SourceFile",
          displayName: "auth/token.ts",
          kind: "file",
          snippet: "function refreshToken()",
          score: 0.94,
          isSystem: true,
        },
      ],
    });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.nodeId).toBe("node_abc");
    expect(parsed.results[0]?.kind).toBe("file");
    expect(parsed.results[0]?.score).toBe(0.94);
    expect(parsed.results[0]?.isSystem).toBe(true);
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
            label: "SourceFile",
            displayName: "auth.ts",
            kind: "file",
            snippet: "code",
            isSystem: true,
            // score missing
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("graph.search")).toBe(graphSearch);
  });
});
