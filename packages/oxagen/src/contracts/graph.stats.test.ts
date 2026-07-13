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

  // ── input: includeGrowth ───────────────────────────────────────────────────

  it("defaults includeGrowth to false on empty input", () => {
    const parsed = graphStats.input.parse({});
    expect(parsed.includeGrowth).toBe(false);
  });

  it("accepts includeGrowth=true", () => {
    const parsed = graphStats.input.parse({ includeGrowth: true });
    expect(parsed.includeGrowth).toBe(true);
  });

  it("accepts includeGrowth alongside includeByType", () => {
    const parsed = graphStats.input.parse({
      includeByType: true,
      includeGrowth: true,
    });
    expect(parsed.includeByType).toBe(true);
    expect(parsed.includeGrowth).toBe(true);
  });

  it("rejects a non-boolean includeGrowth", () => {
    expect(() => graphStats.input.parse({ includeGrowth: "yes" })).toThrow();
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

  // ── output: growth block (optional) ─────────────────────────────────────────

  it("parses output without growth (optional — old consumers unaffected)", () => {
    const parsed = graphStats.output.parse({
      nodeCount: 5,
      edgeCount: 3,
      inferredEdgeCount: 1,
      sourceCount: 1,
      lastModifiedAt: "2024-06-01T00:00:00.000Z",
    });
    expect(parsed.growth).toBeUndefined();
  });

  it("parses output with a growth block", () => {
    const parsed = graphStats.output.parse({
      nodeCount: 5,
      edgeCount: 3,
      inferredEdgeCount: 1,
      sourceCount: 1,
      lastModifiedAt: "2024-06-01T00:00:00.000Z",
      growth: {
        nodesToday: 4,
        nodesYesterday: 2,
        nodesThisWeek: 10,
        nodesLastWeek: 6,
        daily: [
          { day: "2024-05-19", count: 0 },
          { day: "2024-06-01", count: 4 },
        ],
      },
    });
    expect(parsed.growth?.nodesToday).toBe(4);
    expect(parsed.growth?.nodesYesterday).toBe(2);
    expect(parsed.growth?.nodesThisWeek).toBe(10);
    expect(parsed.growth?.nodesLastWeek).toBe(6);
    expect(parsed.growth?.daily).toHaveLength(2);
    expect(parsed.growth?.daily[1]).toEqual({ day: "2024-06-01", count: 4 });
  });

  it("rejects growth with a negative bucket", () => {
    expect(() =>
      graphStats.output.parse({
        nodeCount: 5,
        edgeCount: 3,
        inferredEdgeCount: 1,
        sourceCount: 1,
        lastModifiedAt: "2024-06-01T00:00:00.000Z",
        growth: {
          nodesToday: -1,
          nodesYesterday: 2,
          nodesThisWeek: 10,
          nodesLastWeek: 6,
          daily: [],
        },
      }),
    ).toThrow();
  });

  it("rejects growth with a non-integer bucket", () => {
    expect(() =>
      graphStats.output.parse({
        nodeCount: 5,
        edgeCount: 3,
        inferredEdgeCount: 1,
        sourceCount: 1,
        lastModifiedAt: "2024-06-01T00:00:00.000Z",
        growth: {
          nodesToday: 1.5,
          nodesYesterday: 2,
          nodesThisWeek: 10,
          nodesLastWeek: 6,
          daily: [],
        },
      }),
    ).toThrow();
  });

  it("rejects growth missing a required bucket", () => {
    expect(() =>
      graphStats.output.parse({
        nodeCount: 5,
        edgeCount: 3,
        inferredEdgeCount: 1,
        sourceCount: 1,
        lastModifiedAt: "2024-06-01T00:00:00.000Z",
        growth: {
          nodesToday: 1,
          nodesYesterday: 2,
          nodesThisWeek: 10,
          daily: [],
        },
      }),
    ).toThrow();
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
    expect(getCapability("get_graph_stats")).toBe(graphStats);
  });
});
