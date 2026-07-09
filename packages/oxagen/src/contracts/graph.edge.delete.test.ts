import { describe, expect, it } from "vitest";
import { graphEdgeDelete } from "./graph.edge.delete";
import { getCapability } from "../registry";

describe("graph.edge.delete capability", () => {
  // ── input: fromNodeId / toNodeId ──────────────────────────────────────────

  it("accepts valid fromNodeId and toNodeId strings", () => {
    const parsed = graphEdgeDelete.input.parse({
      fromNodeId: "node_abc",
      toNodeId: "node_xyz",
      edgeType: "RELATED_TO",
    });
    expect(parsed.fromNodeId).toBe("node_abc");
    expect(parsed.toNodeId).toBe("node_xyz");
  });

  it("rejects missing fromNodeId", () => {
    expect(() =>
      graphEdgeDelete.input.parse({ toNodeId: "node_xyz", edgeType: "RELATED_TO" }),
    ).toThrow();
  });

  it("rejects missing toNodeId", () => {
    expect(() =>
      graphEdgeDelete.input.parse({ fromNodeId: "node_abc", edgeType: "RELATED_TO" }),
    ).toThrow();
  });

  it("rejects non-string fromNodeId", () => {
    expect(() =>
      graphEdgeDelete.input.parse({ fromNodeId: 123, toNodeId: "node_xyz", edgeType: "RELATED_TO" }),
    ).toThrow();
  });

  // ── input: edgeType enum ──────────────────────────────────────────────────

  it("accepts all valid edge types", () => {
    const validTypes = [
      "RELATED_TO",
      "PART_OF",
      "CAUSED_BY",
      "REFERENCES",
      "SIMILAR_TO",
      "DEPENDS_ON",
      "CREATED_BY",
      "MENTIONS",
    ] as const;

    for (const edgeType of validTypes) {
      const parsed = graphEdgeDelete.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        edgeType,
      });
      expect(parsed.edgeType).toBe(edgeType);
    }
  });

  // The fixed enum is gone (§3.2) — any lexically-valid relationship type is now
  // accepted (the registry active-vocabulary allow-list is enforced at the handler,
  // not the contract). The contract only rejects types that fail the lexical guard.
  it("accepts a workspace-defined relationship type matching the lexical guard", () => {
    const parsed = graphEdgeDelete.input.parse({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      edgeType: "SIGNED_CONTRACT",
    });
    expect(parsed.edgeType).toBe("SIGNED_CONTRACT");
  });

  it("rejects a relationship type that fails the lexical guard (injection-shaped)", () => {
    expect(() =>
      graphEdgeDelete.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        edgeType: "`]->()-[:x",
      }),
    ).toThrow();
  });

  it("rejects a lowercase relationship type", () => {
    expect(() =>
      graphEdgeDelete.input.parse({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        edgeType: "signed_contract",
      }),
    ).toThrow();
  });

  it("rejects a missing edgeType field", () => {
    expect(() =>
      graphEdgeDelete.input.parse({ fromNodeId: "node_a", toNodeId: "node_b" }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses output with deleted=true", () => {
    const parsed = graphEdgeDelete.output.parse({ deleted: true });
    expect(parsed.deleted).toBe(true);
  });

  it("parses output with deleted=false", () => {
    const parsed = graphEdgeDelete.output.parse({ deleted: false });
    expect(parsed.deleted).toBe(false);
  });

  it("rejects output missing the deleted field", () => {
    expect(() => graphEdgeDelete.output.parse({})).toThrow();
  });

  it("rejects output with non-boolean deleted", () => {
    expect(() => graphEdgeDelete.output.parse({ deleted: "yes" })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("delete_edge")).toBe(graphEdgeDelete);
  });
});
