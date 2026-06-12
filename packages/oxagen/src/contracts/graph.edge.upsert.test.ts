import { describe, expect, it } from "vitest";
import { graphEdgeUpsert, GRAPH_EDGE_TYPES } from "./graph.edge.upsert";
import { getCapability } from "../registry";

describe("graph.edge.upsert capability", () => {
  // ── input: fromNodeId / toNodeId ──────────────────────────────────────────

  it("accepts valid fromNodeId and toNodeId", () => {
    const parsed = graphEdgeUpsert.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      edgeType: "RELATED_TO",
    });
    expect(parsed.fromNodeId).toBe("node_a");
    expect(parsed.toNodeId).toBe("node_b");
  });

  it("rejects missing fromNodeId", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ toNodeId: "node_b", edgeType: "RELATED_TO" }),
    ).toThrow();
  });

  it("rejects missing toNodeId", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ fromNodeId: "node_a", edgeType: "RELATED_TO" }),
    ).toThrow();
  });

  it("rejects non-string fromNodeId", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ fromNodeId: 99, toNodeId: "node_b", edgeType: "RELATED_TO" }),
    ).toThrow();
  });

  // ── input: edgeType enum ──────────────────────────────────────────────────

  it("exports GRAPH_EDGE_TYPES with expected members", () => {
    expect(GRAPH_EDGE_TYPES).toContain("RELATED_TO");
    expect(GRAPH_EDGE_TYPES).toContain("PART_OF");
    expect(GRAPH_EDGE_TYPES).toContain("MENTIONS");
  });

  it("accepts every valid edge type", () => {
    for (const edgeType of GRAPH_EDGE_TYPES) {
      const parsed = graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        edgeType,
      });
      expect(parsed.edgeType).toBe(edgeType);
    }
  });

  it("rejects an unknown edge type", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        edgeType: "KNOWS",
      }),
    ).toThrow();
  });

  it("rejects a missing edgeType", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ fromNodeId: "node_a", toNodeId: "node_b" }),
    ).toThrow();
  });

  // ── input: properties (optional) ─────────────────────────────────────────

  it("accepts properties omitted (optional)", () => {
    const parsed = graphEdgeUpsert.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      edgeType: "DEPENDS_ON",
    });
    expect(parsed.properties).toBeUndefined();
  });

  it("accepts string key-value properties", () => {
    const parsed = graphEdgeUpsert.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      edgeType: "DEPENDS_ON",
      properties: { weight: "high", since: "2024-01-01" },
    });
    expect(parsed.properties?.["weight"]).toBe("high");
  });

  it("rejects properties with non-string values", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        edgeType: "DEPENDS_ON",
        properties: { count: 5 },
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with edgeId and created=true", () => {
    const parsed = graphEdgeUpsert.output.parse({
      edgeId: "node_a:RELATED_TO:node_b",
      created: true,
    });
    expect(parsed.edgeId).toBe("node_a:RELATED_TO:node_b");
    expect(parsed.created).toBe(true);
  });

  it("parses output with created=false (existing edge)", () => {
    const parsed = graphEdgeUpsert.output.parse({
      edgeId: "node_a:RELATED_TO:node_b",
      created: false,
    });
    expect(parsed.created).toBe(false);
  });

  it("rejects output missing edgeId", () => {
    expect(() => graphEdgeUpsert.output.parse({ created: true })).toThrow();
  });

  it("rejects output missing created", () => {
    expect(() => graphEdgeUpsert.output.parse({ edgeId: "node_a:RELATED_TO:node_b" })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("graph.edge.upsert")).toBe(graphEdgeUpsert);
  });
});
