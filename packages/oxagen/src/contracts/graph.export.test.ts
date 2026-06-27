import { describe, expect, it } from "vitest";
import { graphExport } from "./graph.export";
import { getCapability } from "../registry";

describe("graph.export capability", () => {
  // ── input: defaults ─────────────────────────────────────────────────────────
  it("defaults limit to 500", () => {
    expect(graphExport.input.parse({}).limit).toBe(500);
  });
  it("defaults offset to 0", () => {
    expect(graphExport.input.parse({}).offset).toBe(0);
  });
  it("defaults includeEdges to true", () => {
    expect(graphExport.input.parse({}).includeEdges).toBe(true);
  });
  it("leaves labels / isSystem / updatedAfter undefined by default", () => {
    const p = graphExport.input.parse({});
    expect(p.labels).toBeUndefined();
    expect(p.isSystem).toBeUndefined();
    expect(p.updatedAfter).toBeUndefined();
  });

  // ── input: bounds ───────────────────────────────────────────────────────────
  it("accepts limit at the bounds (1 and 1000)", () => {
    expect(graphExport.input.parse({ limit: 1 }).limit).toBe(1);
    expect(graphExport.input.parse({ limit: 1000 }).limit).toBe(1000);
  });
  it("rejects limit above 1000", () => {
    expect(() => graphExport.input.parse({ limit: 1001 })).toThrow();
  });
  it("rejects a negative offset", () => {
    expect(() => graphExport.input.parse({ offset: -1 })).toThrow();
  });
  it("accepts an incremental cursor + filters", () => {
    const p = graphExport.input.parse({
      updatedAfter: "2026-06-27T00:00:00.000Z",
      labels: ["Feature", "Issue"],
      isSystem: false,
      includeEdges: false,
    });
    expect(p.updatedAfter).toBe("2026-06-27T00:00:00.000Z");
    expect(p.labels).toEqual(["Feature", "Issue"]);
    expect(p.isSystem).toBe(false);
    expect(p.includeEdges).toBe(false);
  });

  // ── output: shape ───────────────────────────────────────────────────────────
  it("accepts a well-formed export page (nodes + edges + cursor)", () => {
    const out = graphExport.output.parse({
      nodes: [
        { id: "node_1", labels: ["Feature"], displayName: "Login", properties: { x: 1 }, isSystem: false, updatedAt: "2026-06-27T00:00:00.000Z" },
      ],
      edges: [
        { id: "edge_1", sourceId: "node_1", targetId: "node_2", type: "DEPENDS_ON", properties: {}, inferred: false },
      ],
      total: 1,
      hasMore: false,
      limit: 500,
      offset: 0,
      cursor: "2026-06-27T00:00:00.000Z",
    });
    expect(out.nodes[0]?.id).toBe("node_1");
    expect(out.edges[0]?.type).toBe("DEPENDS_ON");
    expect(out.cursor).toBe("2026-06-27T00:00:00.000Z");
  });
  it("allows a null cursor (no more pages)", () => {
    const out = graphExport.output.parse({
      nodes: [], edges: [], total: 0, hasMore: false, limit: 500, offset: 0, cursor: null,
    });
    expect(out.cursor).toBeNull();
  });

  // ── registry ────────────────────────────────────────────────────────────────
  it("is registered as a scoped, read capability on api + mcp", () => {
    const cap = getCapability("graph.export");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.agent?.category).toBe("read");
  });
});
