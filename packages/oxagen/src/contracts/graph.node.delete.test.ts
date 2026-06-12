import { describe, expect, it } from "vitest";
import { graphNodeDelete } from "./graph.node.delete";
import { getCapability } from "../registry";

describe("graph.node.delete capability", () => {
  // ── input: nodeId ─────────────────────────────────────────────────────────

  it("accepts a valid nodeId string", () => {
    const parsed = graphNodeDelete.input.parse({ nodeId: "kn_abc123" });
    expect(parsed.nodeId).toBe("kn_abc123");
  });

  it("rejects a missing nodeId field", () => {
    expect(() => graphNodeDelete.input.parse({})).toThrow();
  });

  it("rejects a non-string nodeId", () => {
    expect(() => graphNodeDelete.input.parse({ nodeId: 99 })).toThrow();
  });

  it("rejects null as nodeId", () => {
    expect(() => graphNodeDelete.input.parse({ nodeId: null })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses output with deleted=true", () => {
    const parsed = graphNodeDelete.output.parse({ deleted: true });
    expect(parsed.deleted).toBe(true);
  });

  it("parses output with deleted=false (node not found)", () => {
    const parsed = graphNodeDelete.output.parse({ deleted: false });
    expect(parsed.deleted).toBe(false);
  });

  it("rejects output missing deleted field", () => {
    expect(() => graphNodeDelete.output.parse({})).toThrow();
  });

  it("rejects output with non-boolean deleted", () => {
    expect(() => graphNodeDelete.output.parse({ deleted: 1 })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("graph.node.delete")).toBe(graphNodeDelete);
  });
});
