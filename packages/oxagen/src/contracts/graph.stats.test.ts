import { describe, expect, it } from "vitest";
import { graphStats } from "./graph.stats";
import { getCapability } from "../registry";

describe("graph.stats capability", () => {
  // ── input: includeByType ──────────────────────────────────────────────────

  it("defaults includeByType to false on empty input", () => {
    const parsed = graphStats.input.parse({});
    expect(parsed.includeByType).toBe(false);
  });

  it("accepts includeByType=true", () => {
    const parsed = graphStats.input.parse({ includeByType: true });
    expect(parsed.includeByType).toBe(true);
  });

  it("accepts includeByType=false explicitly", () => {
    const parsed = graphStats.input.parse({ includeByType: false });
    expect(parsed.includeByType).toBe(false);
  });

  it("rejects a non-boolean includeByType", () => {
    expect(() => graphStats.input.parse({ includeByType: "yes" })).toThrow();
  });

  // ── output shape: required fields ─────────────────────────────────────────

  it("parses a minimal valid output without breakdown fields", () => {
    const parsed = graphStats.output.parse({
      nodeCount: 42,
      edgeCount: 100,
      inferredEdgeCount: 15,
      sourceCount: 3,
      lastModifiedAt: "2024-06-01T00:00:00.000Z",
    });
    expect(parsed.nodeCount).toBe(42);
    expect(parsed.edgeCount).toBe(100);
    expect(parsed.inferredEdgeCount).toBe(15);
    expect(parsed.sourceCount).toBe(3);
    expect(parsed.lastModifiedAt).toBe("2024-06-01T00:00:00.000Z");
    expect(parsed.nodesByLabel).toBeUndefined();
    expect(parsed.edgesByType).toBeUndefined();
  });

  it("parses output with nodesByLabel and edgesByType breakdown", () => {
    const parsed = graphStats.output.parse({
      nodeCount: 10,
      edgeCount: 20,
      inferredEdgeCount: 5,
      sourceCount: 2,
      lastModifiedAt: "2024-06-01T00:00:00.000Z",
      nodesByLabel: { Person: 6, Company: 4 },
      edgesByType: { RELATED_TO: 12, MENTIONS: 8 },
    });
    expect(parsed.nodesByLabel?.["Person"]).toBe(6);
    expect(parsed.nodesByLabel?.["Company"]).toBe(4);
    expect(parsed.edgesByType?.["RELATED_TO"]).toBe(12);
    expect(parsed.edgesByType?.["MENTIONS"]).toBe(8);
  });

  it("parses output with nodesByLabel=undefined (optional)", () => {
    const parsed = graphStats.output.parse({
      nodeCount: 0,
      edgeCount: 0,
      inferredEdgeCount: 0,
      sourceCount: 0,
      lastModifiedAt: "2024-06-01T00:00:00.000Z",
    });
    expect(parsed.nodesByLabel).toBeUndefined();
  });

  it("rejects output missing nodeCount", () => {
    expect(() =>
      graphStats.output.parse({
        edgeCount: 100,
        inferredEdgeCount: 15,
        sourceCount: 3,
        lastModifiedAt: "2024-06-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing edgeCount", () => {
    expect(() =>
      graphStats.output.parse({
        nodeCount: 42,
        inferredEdgeCount: 15,
        sourceCount: 3,
        lastModifiedAt: "2024-06-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing lastModifiedAt", () => {
    expect(() =>
      graphStats.output.parse({
        nodeCount: 42,
        edgeCount: 100,
        inferredEdgeCount: 15,
        sourceCount: 3,
      }),
    ).toThrow();
  });

  it("rejects output with non-number nodeCount", () => {
    expect(() =>
      graphStats.output.parse({
        nodeCount: "many",
        edgeCount: 100,
        inferredEdgeCount: 15,
        sourceCount: 3,
        lastModifiedAt: "2024-06-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("graph.stats")).toBe(graphStats);
  });
});
