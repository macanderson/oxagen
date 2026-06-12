import { describe, expect, it } from "vitest";
import { graphCypher } from "./graph.cypher";
import { getCapability } from "../registry";

describe("graph.cypher capability", () => {
  // ── input: query ──────────────────────────────────────────────────────────

  it("accepts a valid Cypher query string", () => {
    const parsed = graphCypher.input.parse({ query: "MATCH (n) RETURN n LIMIT 10" });
    expect(parsed.query).toBe("MATCH (n) RETURN n LIMIT 10");
  });

  it("rejects an empty query string (min 1)", () => {
    expect(() => graphCypher.input.parse({ query: "" })).toThrow();
  });

  it("rejects a query that exceeds 10000 characters (max)", () => {
    expect(() => graphCypher.input.parse({ query: "a".repeat(10001) })).toThrow();
  });

  it("accepts a query exactly at max length (10000 chars)", () => {
    const parsed = graphCypher.input.parse({ query: "a".repeat(10000) });
    expect(parsed.query).toHaveLength(10000);
  });

  it("rejects a missing query field", () => {
    expect(() => graphCypher.input.parse({ nlQuery: false })).toThrow();
  });

  it("rejects a non-string query", () => {
    expect(() => graphCypher.input.parse({ query: 42 })).toThrow();
  });

  // ── input: nlQuery ────────────────────────────────────────────────────────

  it("defaults nlQuery to false", () => {
    const parsed = graphCypher.input.parse({ query: "MATCH (n) RETURN n" });
    expect(parsed.nlQuery).toBe(false);
  });

  it("accepts nlQuery=true", () => {
    const parsed = graphCypher.input.parse({ query: "find all users", nlQuery: true });
    expect(parsed.nlQuery).toBe(true);
  });

  it("rejects a non-boolean nlQuery", () => {
    expect(() => graphCypher.input.parse({ query: "MATCH (n) RETURN n", nlQuery: "yes" })).toThrow();
  });

  // ── input: params ─────────────────────────────────────────────────────────

  it("accepts params as undefined (optional)", () => {
    const parsed = graphCypher.input.parse({ query: "MATCH (n) RETURN n" });
    expect(parsed.params).toBeUndefined();
  });

  it("accepts params with string, number and boolean values", () => {
    const parsed = graphCypher.input.parse({
      query: "MATCH (n {name: $name, active: $active, score: $score}) RETURN n",
      params: { name: "Alice", active: true, score: 42 },
    });
    expect(parsed.params?.["name"]).toBe("Alice");
    expect(parsed.params?.["active"]).toBe(true);
    expect(parsed.params?.["score"]).toBe(42);
  });

  it("rejects params with an array value (only string|number|boolean allowed)", () => {
    expect(() =>
      graphCypher.input.parse({
        query: "MATCH (n) RETURN n",
        params: { ids: ["a", "b"] },
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with rows, columns and rowCount", () => {
    const parsed = graphCypher.output.parse({
      rows: [{ name: "Alice" }, { name: "Bob" }],
      columns: ["name"],
      rowCount: 2,
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.columns).toEqual(["name"]);
    expect(parsed.rowCount).toBe(2);
  });

  it("parses an empty result set", () => {
    const parsed = graphCypher.output.parse({ rows: [], columns: [], rowCount: 0 });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rowCount).toBe(0);
  });

  it("rejects output missing rowCount", () => {
    expect(() =>
      graphCypher.output.parse({ rows: [], columns: [] }),
    ).toThrow();
  });

  it("rejects output with a non-array rows field", () => {
    expect(() =>
      graphCypher.output.parse({ rows: "not-an-array", columns: [], rowCount: 0 }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("graph.cypher")).toBe(graphCypher);
  });
});
