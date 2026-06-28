import { describe, expect, it } from "vitest";
import { graphRelationshipUpsert } from "./graph.relationship.upsert";

describe("graph.relationship.upsert contract", () => {
  it("registers across api/mcp/agent/cli surfaces", () => {
    expect(graphRelationshipUpsert.name).toBe("graph.relationship.upsert");
    for (const s of ["api", "mcp", "agent", "cli"]) {
      expect(graphRelationshipUpsert.surfaces).toContain(s);
    }
    expect(graphRelationshipUpsert.scoped).toBe(true);
  });

  it("accepts an uppercase relationship type with optional string properties", () => {
    const parsed = graphRelationshipUpsert.input.parse({
      fromNodeId: "a",
      toNodeId: "b",
      relationshipType: "DEPENDS_ON",
      properties: { weight: "1" },
    });
    expect(parsed.relationshipType).toBe("DEPENDS_ON");
  });

  it("rejects a relationship type violating RELATIONSHIP_TYPE_PATTERN", () => {
    expect(() =>
      graphRelationshipUpsert.input.parse({ fromNodeId: "a", toNodeId: "b", relationshipType: "depends_on" }),
    ).toThrow();
  });

  it("rejects non-string property values", () => {
    expect(() =>
      graphRelationshipUpsert.input.parse({
        fromNodeId: "a",
        toNodeId: "b",
        relationshipType: "REL",
        properties: { weight: 1 },
      }),
    ).toThrow();
  });

  it("validates the upsert output (composite id + created flag)", () => {
    const parsed = graphRelationshipUpsert.output.parse({ relationshipId: "a:REL:b", created: true });
    expect(parsed.created).toBe(true);
  });
});
