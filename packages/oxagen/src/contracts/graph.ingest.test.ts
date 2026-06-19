import { describe, expect, it } from "vitest";
import { graphIngest } from "./graph.ingest";

describe("graph.ingest contract", () => {
  it("is exposed on api, mcp, and agent surfaces", () => {
    expect(graphIngest.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("applies the maxEntities default", () => {
    const parsed = graphIngest.input.parse({ text: "some source text" });
    expect(parsed.maxEntities).toBe(25);
  });

  it("rejects empty text and out-of-range maxEntities", () => {
    expect(graphIngest.input.safeParse({ text: "" }).success).toBe(false);
    expect(graphIngest.input.safeParse({ text: "x", maxEntities: 999 }).success).toBe(false);
  });

  it("declares chain metadata (consumes document.text, produces graph ids)", () => {
    expect(graphIngest.consumes).toContain("document.text");
    expect(graphIngest.produces).toContain("graph.nodeId");
    expect(graphIngest.render?.componentId).toBe("graph-ingest-card");
  });

  it("accepts a full ingestion result and constrains edgeType to the graph vocabulary", () => {
    const out = graphIngest.output.parse({
      entities: [{ nodeId: "n1", name: "USS Nautilus", type: "Vessel", confidence: 0.9, created: true }],
      relationships: [
        { edgeId: "e1", from: "A", to: "B", edgeType: "CREATED_BY", confidence: 0.7, created: true },
      ],
      summary: "done",
    });
    expect(out.entities[0]?.nodeId).toBe("n1");
    expect(
      graphIngest.output.safeParse({
        entities: [],
        relationships: [{ edgeId: "e", from: "A", to: "B", edgeType: "NOT_A_REAL_EDGE", confidence: 1, created: true }],
        summary: "x",
      }).success,
    ).toBe(false);
  });
});
