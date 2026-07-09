import { describe, expect, it } from "vitest";
import { semanticEdgeList, semanticEdgeSchema } from "./semantic.edge.list";
import { getCapability } from "../registry";

// ── shared fixture ─────────────────────────────────────────────────────────

const validEdge = {
  id: "edge-001",
  sourceNodeId: "node-src-1",
  targetNodeId: "node-tgt-1",
  type: "RELATES_TO",
  confidence: 0.92,
  source: {
    connectorId: "connector-abc",
    sourceId: "src-internal-42",
  },
  inferredAt: "2024-06-01T12:00:00.000Z",
};

describe("semantic.edge.list capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults limit to 50 on empty input", () => {
    const parsed = semanticEdgeList.input.parse({});
    expect(parsed.limit).toBe(50);
  });

  it("defaults offset to 0 on empty input", () => {
    const parsed = semanticEdgeList.input.parse({});
    expect(parsed.offset).toBe(0);
  });

  it("optional fields are undefined when omitted", () => {
    const parsed = semanticEdgeList.input.parse({});
    expect(parsed.type).toBeUndefined();
    expect(parsed.sourceId).toBeUndefined();
    expect(parsed.confidenceMin).toBeUndefined();
    expect(parsed.confidenceMax).toBeUndefined();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = semanticEdgeList.input.parse({ limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=250 (max)", () => {
    const parsed = semanticEdgeList.input.parse({ limit: 250 });
    expect(parsed.limit).toBe(250);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() => semanticEdgeList.input.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit=251 (above max)", () => {
    expect(() => semanticEdgeList.input.parse({ limit: 251 })).toThrow();
  });

  it("rejects non-integer limit", () => {
    expect(() => semanticEdgeList.input.parse({ limit: 10.5 })).toThrow();
  });

  // ── input: offset bounds ──────────────────────────────────────────────────

  it("accepts offset=0 (min)", () => {
    const parsed = semanticEdgeList.input.parse({ offset: 0 });
    expect(parsed.offset).toBe(0);
  });

  it("rejects negative offset", () => {
    expect(() => semanticEdgeList.input.parse({ offset: -1 })).toThrow();
  });

  it("rejects non-integer offset", () => {
    expect(() => semanticEdgeList.input.parse({ offset: 1.1 })).toThrow();
  });

  // ── input: confidence bounds ──────────────────────────────────────────────

  it("accepts confidenceMin=0 (min boundary)", () => {
    const parsed = semanticEdgeList.input.parse({ confidenceMin: 0 });
    expect(parsed.confidenceMin).toBe(0);
  });

  it("accepts confidenceMax=1 (max boundary)", () => {
    const parsed = semanticEdgeList.input.parse({ confidenceMax: 1 });
    expect(parsed.confidenceMax).toBe(1);
  });

  it("rejects confidenceMin below 0", () => {
    expect(() =>
      semanticEdgeList.input.parse({ confidenceMin: -0.1 }),
    ).toThrow();
  });

  it("rejects confidenceMax above 1", () => {
    expect(() =>
      semanticEdgeList.input.parse({ confidenceMax: 1.1 }),
    ).toThrow();
  });

  // ── semanticEdgeSchema ────────────────────────────────────────────────────

  it("parses a minimal valid edge (no optional approval fields)", () => {
    const parsed = semanticEdgeSchema.parse(validEdge);
    expect(parsed.id).toBe("edge-001");
    expect(parsed.confidence).toBe(0.92);
    expect(parsed.approved).toBeUndefined();
    expect(parsed.approvedAt).toBeUndefined();
    expect(parsed.approvedBy).toBeUndefined();
  });

  it("parses an edge with approval metadata", () => {
    const parsed = semanticEdgeSchema.parse({
      ...validEdge,
      approved: true,
      approvedAt: "2024-06-02T08:00:00.000Z",
      approvedBy: "user-001",
    });
    expect(parsed.approved).toBe(true);
    expect(parsed.approvedAt).toBe("2024-06-02T08:00:00.000Z");
    expect(parsed.approvedBy).toBe("user-001");
  });

  it("parses an edge with null approvedAt and approvedBy", () => {
    const parsed = semanticEdgeSchema.parse({
      ...validEdge,
      approved: false,
      approvedAt: null,
      approvedBy: null,
    });
    expect(parsed.approvedAt).toBeNull();
    expect(parsed.approvedBy).toBeNull();
  });

  it("rejects an edge with confidence above 1", () => {
    expect(() =>
      semanticEdgeSchema.parse({ ...validEdge, confidence: 1.5 }),
    ).toThrow();
  });

  it("rejects an edge with confidence below 0", () => {
    expect(() =>
      semanticEdgeSchema.parse({ ...validEdge, confidence: -0.1 }),
    ).toThrow();
  });

  it("rejects an edge missing sourceNodeId", () => {
    const { sourceNodeId: _, ...rest } = validEdge;
    expect(() => semanticEdgeSchema.parse(rest)).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with one edge", () => {
    const parsed = semanticEdgeList.output.parse({
      edges: [validEdge],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("parses a valid empty output", () => {
    const parsed = semanticEdgeList.output.parse({
      edges: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(parsed.edges).toHaveLength(0);
  });

  it("rejects output missing edges array", () => {
    expect(() =>
      semanticEdgeList.output.parse({ total: 0, limit: 50, offset: 0 }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_semantic_edges")).toBe(semanticEdgeList);
  });
});
