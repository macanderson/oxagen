import { describe, expect, it } from "vitest";
import { semanticEdgeApprove } from "./semantic.edge.approve";
import { getCapability } from "../registry";

describe("semantic.edge.approve capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("parses a minimal valid input (approve, no comment)", () => {
    const parsed = semanticEdgeApprove.input.parse({
      edgeId: "edge-abc-123",
      decision: "approve",
    });
    expect(parsed.edgeId).toBe("edge-abc-123");
    expect(parsed.decision).toBe("approve");
    expect(parsed.comment).toBeUndefined();
  });

  it("parses a minimal valid input with decision=reject", () => {
    const parsed = semanticEdgeApprove.input.parse({
      edgeId: "edge-xyz-999",
      decision: "reject",
    });
    expect(parsed.decision).toBe("reject");
  });

  it("rejects missing edgeId", () => {
    expect(() =>
      semanticEdgeApprove.input.parse({ decision: "approve" }),
    ).toThrow();
  });

  it("rejects empty edgeId (min 1)", () => {
    expect(() =>
      semanticEdgeApprove.input.parse({ edgeId: "", decision: "approve" }),
    ).toThrow();
  });

  it("rejects missing decision", () => {
    expect(() =>
      semanticEdgeApprove.input.parse({ edgeId: "edge-1" }),
    ).toThrow();
  });

  // ── input: decision enum ──────────────────────────────────────────────────

  it("rejects an unknown decision value", () => {
    expect(() =>
      semanticEdgeApprove.input.parse({ edgeId: "edge-1", decision: "defer" }),
    ).toThrow();
  });

  // ── input: comment bounds ─────────────────────────────────────────────────

  it("accepts a comment within the 1000-char max", () => {
    const parsed = semanticEdgeApprove.input.parse({
      edgeId: "edge-1",
      decision: "approve",
      comment: "Looks correct.",
    });
    expect(parsed.comment).toBe("Looks correct.");
  });

  it("accepts comment at exactly 1000 chars (max boundary)", () => {
    const comment = "a".repeat(1000);
    const parsed = semanticEdgeApprove.input.parse({
      edgeId: "edge-1",
      decision: "approve",
      comment,
    });
    expect(parsed.comment).toBe(comment);
  });

  it("rejects comment exceeding 1000 chars", () => {
    expect(() =>
      semanticEdgeApprove.input.parse({
        edgeId: "edge-1",
        decision: "approve",
        comment: "a".repeat(1001),
      }),
    ).toThrow();
  });

  it("rejects wrong type for edgeId", () => {
    expect(() =>
      semanticEdgeApprove.input.parse({ edgeId: 42, decision: "approve" }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid approve output with permanentEdgeId", () => {
    const parsed = semanticEdgeApprove.output.parse({
      edgeId: "edge-abc-123",
      decision: "approve",
      permanentEdgeId: "neo4j-elem-id-001",
    });
    expect(parsed.edgeId).toBe("edge-abc-123");
    expect(parsed.decision).toBe("approve");
    expect(parsed.permanentEdgeId).toBe("neo4j-elem-id-001");
  });

  it("parses a valid reject output without permanentEdgeId", () => {
    const parsed = semanticEdgeApprove.output.parse({
      edgeId: "edge-abc-123",
      decision: "reject",
    });
    expect(parsed.decision).toBe("reject");
    expect(parsed.permanentEdgeId).toBeUndefined();
  });

  it("rejects output with unknown decision value", () => {
    expect(() =>
      semanticEdgeApprove.output.parse({
        edgeId: "edge-abc-123",
        decision: "pending",
      }),
    ).toThrow();
  });

  it("rejects output missing edgeId", () => {
    expect(() =>
      semanticEdgeApprove.output.parse({ decision: "approve" }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("semantic.edge.approve")).toBe(semanticEdgeApprove);
  });
});
