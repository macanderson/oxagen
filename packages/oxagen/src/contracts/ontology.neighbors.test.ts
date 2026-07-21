import { describe, expect, it } from "vitest";
import { ontologyNeighbors } from "./ontology.neighbors";

describe("ontology.neighbors contract", () => {
  it("is a read-only traversal primitive on api/mcp/agent/cli", () => {
    expect(ontologyNeighbors.name).toBe("get_ontology_neighbors");
    for (const s of ["api", "mcp", "agent", "cli"]) {
      expect(ontologyNeighbors.surfaces).toContain(s);
    }
    expect(ontologyNeighbors.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("defaults direction to 'both' and limit to 100", () => {
    const parsed = ontologyNeighbors.input.parse({ nodeId: "n_1" });
    expect(parsed.direction).toBe("both");
    expect(parsed.limit).toBe(100);
  });

  it("rejects a limit over 500 and invalid edge types", () => {
    expect(() =>
      ontologyNeighbors.input.parse({ nodeId: "n_1", limit: 501 }),
    ).toThrow();
    expect(() =>
      ontologyNeighbors.input.parse({ nodeId: "n_1", edgeTypes: ["bad-type"] }),
    ).toThrow();
  });

  it("validates the neighbors output shape", () => {
    const parsed = ontologyNeighbors.output.parse({
      nodeId: "n_1",
      found: true,
      neighbors: [
        {
          nodeId: "n_2",
          label: "Issue",
          displayName: "Bug",
          description: null,
          edgeType: "RELATES_TO",
          direction: "out",
          validFrom: "2026-01-01T00:00:00Z",
          validTo: null,
          recordedAt: "2026-01-01T00:00:00Z",
          invalidatedAt: null,
        },
      ],
      truncated: false,
    });
    expect(parsed.neighbors[0]?.edgeType).toBe("RELATES_TO");
  });
});
