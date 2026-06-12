import { describe, expect, it } from "vitest";
import { semanticEdgeSuggest } from "./semantic.edge.suggest";
import { getCapability } from "../registry";

// ── shared fixture ─────────────────────────────────────────────────────────

const validEdge = {
  id: "edge-cand-1",
  sourceNodeId: "node-a",
  targetNodeId: "node-b",
  type: "SIMILAR_TO",
  confidence: 0.75,
  source: {
    connectorId: "connector-x",
    sourceId: "src-99",
  },
  inferredAt: "2024-07-01T00:00:00.000Z",
};

describe("semantic.edge.suggest capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults limit to 50 on empty input", () => {
    const parsed = semanticEdgeSuggest.input.parse({});
    expect(parsed.limit).toBe(50);
  });

  it("optional confidence bounds are undefined when omitted", () => {
    const parsed = semanticEdgeSuggest.input.parse({});
    expect(parsed.confidenceMin).toBeUndefined();
    expect(parsed.confidenceMax).toBeUndefined();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = semanticEdgeSuggest.input.parse({ limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=250 (max)", () => {
    const parsed = semanticEdgeSuggest.input.parse({ limit: 250 });
    expect(parsed.limit).toBe(250);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() => semanticEdgeSuggest.input.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit=251 (above max)", () => {
    expect(() => semanticEdgeSuggest.input.parse({ limit: 251 })).toThrow();
  });

  it("rejects non-integer limit", () => {
    expect(() => semanticEdgeSuggest.input.parse({ limit: 5.5 })).toThrow();
  });

  // ── input: confidence bounds ──────────────────────────────────────────────

  it("accepts confidenceMin=0 (min boundary)", () => {
    const parsed = semanticEdgeSuggest.input.parse({ confidenceMin: 0 });
    expect(parsed.confidenceMin).toBe(0);
  });

  it("accepts confidenceMax=1 (max boundary)", () => {
    const parsed = semanticEdgeSuggest.input.parse({ confidenceMax: 1 });
    expect(parsed.confidenceMax).toBe(1);
  });

  it("rejects confidenceMin below 0", () => {
    expect(() =>
      semanticEdgeSuggest.input.parse({ confidenceMin: -0.01 }),
    ).toThrow();
  });

  it("rejects confidenceMax above 1", () => {
    expect(() =>
      semanticEdgeSuggest.input.parse({ confidenceMax: 1.01 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with suggestions", () => {
    const parsed = semanticEdgeSuggest.output.parse({
      suggestions: [validEdge],
      total: 1,
      limit: 50,
    });
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]?.id).toBe("edge-cand-1");
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(50);
  });

  it("parses a valid output with empty suggestions", () => {
    const parsed = semanticEdgeSuggest.output.parse({
      suggestions: [],
      total: 0,
      limit: 50,
    });
    expect(parsed.suggestions).toHaveLength(0);
  });

  it("parses suggestions with optional approval fields omitted", () => {
    const parsed = semanticEdgeSuggest.output.parse({
      suggestions: [validEdge],
      total: 1,
      limit: 50,
    });
    expect(parsed.suggestions[0]?.approved).toBeUndefined();
    expect(parsed.suggestions[0]?.approvedAt).toBeUndefined();
  });

  it("parses suggestions with null approvedAt and approvedBy", () => {
    const parsed = semanticEdgeSuggest.output.parse({
      suggestions: [
        { ...validEdge, approved: false, approvedAt: null, approvedBy: null },
      ],
      total: 1,
      limit: 50,
    });
    expect(parsed.suggestions[0]?.approvedAt).toBeNull();
    expect(parsed.suggestions[0]?.approvedBy).toBeNull();
  });

  it("rejects output missing total", () => {
    expect(() =>
      semanticEdgeSuggest.output.parse({ suggestions: [], limit: 50 }),
    ).toThrow();
  });

  it("rejects output missing suggestions", () => {
    expect(() =>
      semanticEdgeSuggest.output.parse({ total: 0, limit: 50 }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("semantic.edge.suggest")).toBe(semanticEdgeSuggest);
  });
});
