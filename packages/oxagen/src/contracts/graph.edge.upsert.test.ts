import { describe, expect, it } from "vitest";
import { graphEdgeUpsert } from "./graph.edge.upsert";
import { getCapability } from "../registry";

// graph.edge.upsert is a one-release DEPRECATION ALIAS of graph.relationship.upsert
// (Workspace Schema Registry §1.2). The fixed GRAPH_EDGE_TYPES enum is GONE (§3.2):
// the input now carries a regex-validated `relationshipType` (the lexical
// RELATIONSHIP_TYPE_PATTERN guard), not an enum.
describe("graph.edge.upsert capability (deprecation alias)", () => {
  // ── input: fromNodeId / toNodeId ──────────────────────────────────────────

  it("accepts valid fromNodeId and toNodeId", () => {
    const parsed = graphEdgeUpsert.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relationshipType: "RELATED_TO",
    });
    expect(parsed.fromNodeId).toBe("node_a");
    expect(parsed.toNodeId).toBe("node_b");
  });

  it("rejects missing fromNodeId", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ toNodeId: "node_b", relationshipType: "RELATED_TO" }),
    ).toThrow();
  });

  it("rejects missing toNodeId", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ fromNodeId: "node_a", relationshipType: "RELATED_TO" }),
    ).toThrow();
  });

  it("rejects non-string fromNodeId", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({
        fromNodeId: 99,
        toNodeId: "node_b",
        relationshipType: "RELATED_TO",
      }),
    ).toThrow();
  });

  // ── input: relationshipType (regex guard, no enum) ────────────────────────

  it("accepts any workspace-defined relationship type matching the lexical guard", () => {
    for (const relationshipType of ["RELATED_TO", "SIGNED_CONTRACT", "EMPLOYS", "X"]) {
      const parsed = graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationshipType,
      });
      expect(parsed.relationshipType).toBe(relationshipType);
    }
  });

  it("rejects a relationship type that fails the lexical guard (injection-shaped)", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationshipType: "`]->()-[:x",
      }),
    ).toThrow();
  });

  it("rejects a lowercase relationship type", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationshipType: "knows",
      }),
    ).toThrow();
  });

  it("rejects a missing relationshipType", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({ fromNodeId: "node_a", toNodeId: "node_b" }),
    ).toThrow();
  });

  // ── input: properties (optional) ─────────────────────────────────────────

  it("accepts properties omitted (optional)", () => {
    const parsed = graphEdgeUpsert.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relationshipType: "DEPENDS_ON",
    });
    expect(parsed.properties).toBeUndefined();
  });

  it("accepts string key-value properties", () => {
    const parsed = graphEdgeUpsert.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relationshipType: "DEPENDS_ON",
      properties: { weight: "high", since: "2024-01-01" },
    });
    expect(parsed.properties?.["weight"]).toBe("high");
  });

  it("rejects properties with non-string values", () => {
    expect(() =>
      graphEdgeUpsert.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationshipType: "DEPENDS_ON",
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
    expect(getCapability("upsert_edge")).toBe(graphEdgeUpsert);
  });
});
